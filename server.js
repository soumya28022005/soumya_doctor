import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import cors from "cors";

const { Pool } = pg; // Use Pool for better connection management
const app = express();
const port = process.env.PORT || 3000; // Use environment variable or default

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Database Connection ---
const db = new Pool({
    // Replace with your actual Supabase connection string
    connectionString: "postgresql://postgres:Soumya2802@@db.rancgomqjngwawhbuymy.supabase.co:5432/postgres",
    ssl: { rejectUnauthorized: false }
});

// Test DB connection on startup (optional but recommended)
db.connect((err, client, release) => {
    if (err) {
        return console.error('Error acquiring client', err.stack);
    }
    client.query('SELECT NOW()', (err, result) => {
        release(); // Release the client back to the pool
        if (err) {
            return console.error('Error executing query', err.stack);
        }
        console.log('Database connected successfully:', result.rows[0].now);
    });
});


// --- Helper Functions ---
async function getNextQueueNumber(doctorId, date, clinicId) {
    // Use the pool directly to query
    const result = await db.query(
        "SELECT COUNT(*) FROM appointments WHERE doctor_id = $1 AND date = $2 AND clinic_id = $3",
        [doctorId, date, clinicId]
    );
    return parseInt(result.rows[0].count) + 1;
}

// Function to check for schedule conflicts
async function checkScheduleConflict(doctorId, startTime, endTime, days, scheduleIdToExclude = null) {
    // Use the pool directly to query
    let query = 'SELECT * FROM doctor_schedules WHERE doctor_id = $1';
    const params = [doctorId];
    if (scheduleIdToExclude) {
        query += ' AND id != $2';
        params.push(scheduleIdToExclude);
    }
    const { rows: existingSchedules } = await db.query(query, params);

    const newDaysArray = days.split(','); // Assumes days are comma-separated like "Monday,Wednesday"

    for (const schedule of existingSchedules) {
        const existingDaysArray = schedule.days.split(',');
        // Check if there's any common day between the new schedule and existing ones
        const hasCommonDay = newDaysArray.some(day => existingDaysArray.includes(day));

        if (hasCommonDay) {
            // Check for time overlap only if days overlap
            const existingStart = schedule.start_time;
            const existingEnd = schedule.end_time;
            // Overlap condition: (StartA < EndB) and (EndA > StartB)
            if (startTime < existingEnd && endTime > existingStart) {
                return true; // Conflict found
            }
        }
    }
    return false; // No conflict found
}


// --- API ROUTES ---

// --- Auth ---
app.post("/api/login/:role", async (req, res) => {
    const { role } = req.params;
    const { username, password } = req.body;
    const tableName = `${role}s`; // Make sure table names match (e.g., patients, doctors, admins, receptionists)
    try {
        const result = await db.query(`SELECT * FROM ${tableName} WHERE username = $1 AND password = $2`, [username, password]);
        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.json({ success: false, message: "Invalid username or password." });
        }
    } catch (err) {
        console.error(`Login Error (${role}):`, err);
        res.status(500).json({ success: false, message: "Error logging in." });
    }
});

app.post("/api/signup/patient", async (req, res) => {
    const { name, dob, mobile, username, password } = req.body;

    // Basic Validation (Check if required fields are provided)
    if (!name || !dob || !mobile || !username || !password) {
        return res.status(400).json({ success: false, message: "Please fill in all required fields." });
    }

    try {
        // Check if mobile number already exists
        const existingPatientByMobile = await db.query("SELECT id FROM patients WHERE mobile = $1", [mobile]);
        if (existingPatientByMobile.rows.length > 0) {
            return res.status(400).json({ success: false, message: "This mobile number is already registered." });
        }

        // Check if username already exists
        const existingPatientByUsername = await db.query("SELECT id FROM patients WHERE username = $1", [username]);
        if (existingPatientByUsername.rows.length > 0) {
            return res.status(400).json({ success: false, message: "This username is already taken." });
        }

        // Insert new patient
        const result = await db.query(
            "INSERT INTO patients (name, dob, mobile, username, password) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            [name, dob, mobile, username, password]
        );
        res.json({ success: true, user: result.rows[0] });

    } catch (err) {
        console.error("Signup Error:", err); // Log the detailed error on the server

        // Provide more specific feedback based on common errors
        if (err.code === '23505') { // Unique constraint violation
             if (err.constraint && err.constraint.includes('username')) {
                 res.status(400).json({ success: false, message: "This username is already taken. Please choose another." });
             } else if (err.constraint && err.constraint.includes('mobile')) { // Assuming you have a unique constraint on mobile
                 res.status(400).json({ success: false, message: "This mobile number is already registered." });
             } else {
                 res.status(400).json({ success: false, message: "A unique field conflict occurred. Please check your inputs." });
             }
        } else if (err.code === '23502') { // Not-null constraint violation
             res.status(400).json({ success: false, message: `Missing required information: ${err.column}. Please fill all fields.` });
        } else {
             // Generic error for other issues
             res.status(500).json({ success: false, message: "An internal server error occurred during signup. Please try again later." });
        }
    }
});


// --- Dashboard Data ---
app.get("/api/dashboard/:role/:userId", async (req, res) => {
    const { role, userId } = req.params;
    const { clinicId } = req.query; // Capture clinicId from query
    try {
        const userRes = await db.query(`SELECT * FROM ${role}s WHERE id = $1`, [userId]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: `${role} not found` });

        let data = { success: true, [role]: userRes.rows[0] };

        if (role === 'patient') {
            // Fetch appointments with doctor and clinic names
            const appointmentsRes = await db.query(
                `SELECT a.*, d.name as doctor_name, c.name as clinic_name, p.dob
                 FROM appointments a
                 JOIN doctors d ON a.doctor_id = d.id
                 JOIN clinics c ON a.clinic_id = c.id
                 JOIN patients p ON a.patient_id = p.id
                 WHERE a.patient_id = $1
                 ORDER BY a.date DESC, a."time" ASC`, // Use quotes for "time"
                [userId]
            );
            data.appointments = appointmentsRes.rows;
        } else if (role === 'doctor') {
            const today = new Date().toISOString().slice(0, 10);

            let appointmentsQuery = `
                SELECT a.*, p.name as patient_name, p.dob
                FROM appointments a
                JOIN patients p ON a.patient_id = p.id
                WHERE a.doctor_id = $1 AND a.date = $2
                ORDER BY a.queue_number ASC`;
            let appointmentsParams = [userId, today];

            if (clinicId) {
                appointmentsQuery = `
                    SELECT a.*, p.name as patient_name, p.dob
                    FROM appointments a
                    JOIN patients p ON a.patient_id = p.id
                    WHERE a.doctor_id = $1 AND a.date = $2 AND a.clinic_id = $3
                    ORDER BY a.queue_number ASC`;
                appointmentsParams.push(clinicId);
            }

            const [appointmentsRes, schedulesRes, clinicsRes, requestsRes, invitationsRes] = await Promise.all([
                db.query(appointmentsQuery, appointmentsParams),
                db.query(`SELECT ds.*, c.name as clinic_name FROM doctor_schedules ds JOIN clinics c ON ds.clinic_id = c.id WHERE ds.doctor_id = $1 ORDER BY ds.start_time`, [userId]),
                db.query("SELECT id, name FROM clinics ORDER BY name"), // Fetch only needed fields
                db.query("SELECT cjr.*, c.name as clinic_name FROM clinic_join_requests cjr JOIN clinics c ON cjr.clinic_id = c.id WHERE cjr.doctor_id = $1", [userId]),
                db.query(`SELECT ri.*, c.name as clinic_name FROM receptionist_invitations ri JOIN clinics c ON ri.clinic_id = c.id WHERE ri.doctor_id = $1`, [userId])
            ]);
            data = { ...data, appointments: appointmentsRes.rows, schedules: schedulesRes.rows, clinics: clinicsRes.rows, doctorRequests: requestsRes.rows, invitations: invitationsRes.rows };
        } else if (role === 'receptionist') {
            const user = userRes.rows[0];
            if (!user.clinic_id) {
                return res.status(400).json({ success: false, message: "Receptionist not assigned to a clinic." });
            }
            const [clinicRes, appointmentsRes, clinicDocsRes, allDocsRes, requestsRes, invitationsRes, patientsRes] = await Promise.all([
                 db.query("SELECT * FROM clinics WHERE id = $1", [user.clinic_id]),
                 // Fetch appointments only for today for the receptionist's clinic
                 db.query(`
                    SELECT a.*, p.name as patient_name, d.name as doctor_name
                    FROM appointments a
                    LEFT JOIN patients p ON a.patient_id = p.id
                    JOIN doctors d ON a.doctor_id = d.id
                    WHERE a.clinic_id = $1 AND a.date = $2
                    ORDER BY d.name, a.queue_number ASC`,
                    [user.clinic_id, new Date().toISOString().slice(0, 10)]),
                 // Fetch doctors scheduled specifically at this clinic
                 db.query(`
                    SELECT d.id, d.name, d.specialty, ds.start_time, ds.end_time, ds.days
                    FROM doctors d
                    JOIN doctor_schedules ds ON d.id = ds.doctor_id
                    WHERE ds.clinic_id = $1 ORDER BY d.name`,
                    [user.clinic_id]),
                 db.query("SELECT id, name, phone FROM doctors ORDER BY name"), // Fetch all doctors for inviting
                 db.query("SELECT cjr.*, d.name as doctor_name, d.specialty as doctor_specialty FROM clinic_join_requests cjr JOIN doctors d ON cjr.doctor_id = d.id WHERE cjr.clinic_id = $1 AND cjr.status = 'pending'", [user.clinic_id]),
                 // Fetch pending invitations sent *by* this clinic (or associated receptionists)
                 db.query("SELECT ri.*, d.name as doctor_name FROM receptionist_invitations ri JOIN doctors d ON ri.doctor_id = d.id WHERE ri.clinic_id = $1", [user.clinic_id]),
                 db.query("SELECT id, name, dob, mobile FROM patients ORDER BY name") // Fetch patients for booking maybe?
            ]);
            data = { ...data, clinic: clinicRes.rows[0], appointments: appointmentsRes.rows, doctors: clinicDocsRes.rows, allDoctors: allDocsRes.rows, joinRequests: requestsRes.rows, invitations: invitationsRes.rows, patients: patientsRes.rows };
        } else if (role === 'admin') {
             const [patientsRes, doctorsRes, clinicsRes, appointmentsRes, receptionistsRes] = await Promise.all([
                db.query("SELECT id, name, username, password, mobile FROM patients ORDER BY name"), // Include password for admin view
                db.query("SELECT * FROM doctors ORDER BY name"), // Admin sees doctor password
                db.query("SELECT c.*, r.name as receptionist_name, r.username as receptionist_username, r.password as receptionist_password FROM clinics c LEFT JOIN receptionists r ON c.id = r.clinic_id ORDER BY c.name"),
                db.query("SELECT a.*, p.name as patient_name, d.name as doctor_name, c.name as clinic_name FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id JOIN doctors d ON a.doctor_id = d.id JOIN clinics c ON a.clinic_id = c.id ORDER BY a.date DESC, a.\"time\" ASC"),
                db.query("SELECT * FROM receptionists ORDER BY name") // Fetch separately if needed
            ]);
            data = { ...data, patients: patientsRes.rows, doctors: doctorsRes.rows, clinics: clinicsRes.rows, appointments: appointmentsRes.rows, receptionists: receptionistsRes.rows };
        }
        res.json(data);
    } catch (err) {
        console.error(`Dashboard error (${role}):`, err);
        res.status(500).json({ success: false, message: `Error fetching ${role} data.` });
    }
});


// --- Search and General GET ---
app.get("/api/doctors", async (req, res) => {
    // This route seems primarily for patient search, let's keep it focused
    const { name, specialty, clinic, date } = req.query; // Added date
    try {
        let query = `SELECT DISTINCT d.id, d.name, d.specialty, d.phone FROM doctors d`;
        let joinClauses = '';
        let whereClauses = [];
        let params = [];
        let paramIndex = 1;

        if (clinic) {
            joinClauses += ` JOIN doctor_schedules ds_clinic ON d.id = ds_clinic.doctor_id JOIN clinics c ON ds_clinic.clinic_id = c.id`;
            whereClauses.push(`c.name ILIKE $${paramIndex++}`);
            params.push(`%${clinic}%`);
        }
        if (date) {
             // We need schedules joined regardless if filtering by date
             if (!joinClauses.includes('doctor_schedules')) {
                 joinClauses += ` JOIN doctor_schedules ds_date ON d.id = ds_date.doctor_id`;
             }
            const searchDate = new Date(date);
            const dayOfWeek = searchDate.toLocaleString('en-us', { weekday: 'long' });
             // Adjust the clause to check comma-separated days
            whereClauses.push(`(ds_date.days LIKE '%' || $${paramIndex++} || '%')`);
             params.push(dayOfWeek);
        }

        if (name) {
            whereClauses.push(`d.name ILIKE $${paramIndex++}`);
            params.push(`%${name}%`);
        }
        if (specialty) {
            whereClauses.push(`d.specialty ILIKE $${paramIndex++}`);
            params.push(`%${specialty}%`);
        }

        query += joinClauses;
        if (whereClauses.length > 0) {
            query += ' WHERE ' + whereClauses.join(' AND ');
        }
        query += " ORDER BY d.name";

        const doctorsResult = await db.query(query, params);

        // Fetch available schedules for the found doctors ON THE SPECIFIED DATE
        if (date) {
            const searchDateObj = new Date(date);
            const dayOfWeek = searchDateObj.toLocaleString('en-us', { weekday: 'long' });

            for (let doctor of doctorsResult.rows) {
                const scheduleRes = await db.query(
                    `SELECT ds.id as schedule_id, ds.clinic_id, ds.start_time, ds.end_time, ds.patient_limit, c.name as clinic_name
                     FROM doctor_schedules ds
                     JOIN clinics c ON ds.clinic_id = c.id
                     WHERE ds.doctor_id = $1 AND ds.days LIKE '%' || $2 || '%'`, // Check if the day is in the comma-separated list
                    [doctor.id, dayOfWeek]
                );

                 // Check appointment count against patient_limit for each schedule slot
                 for (let schedule of scheduleRes.rows) {
                     const appCountRes = await db.query(
                         "SELECT COUNT(*) FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 AND date = $3",
                         [doctor.id, schedule.clinic_id, date]
                     );
                     schedule.appointment_count = parseInt(appCountRes.rows[0].count);
                     schedule.is_full = schedule.patient_limit > 0 && schedule.appointment_count >= schedule.patient_limit;
                 }
                // Filter out schedules that are full
                 doctor.schedules = scheduleRes.rows.filter(s => !s.is_full);
            }
        } else {
             // If no date provided, don't fetch schedules in this search context
             doctorsResult.rows.forEach(doc => doc.schedules = []);
        }


        res.json({ success: true, doctors: doctorsResult.rows });
    } catch (err) {
        console.error("Error searching doctors:", err);
        res.status(500).json({ success: false, message: "Error searching doctors." });
    }
});


app.get("/api/clinics/search", async (req, res) => {
    const { name } = req.query;
    try {
        const result = await db.query("SELECT id, name, address FROM clinics WHERE name ILIKE $1 ORDER BY name", [`%${name}%`]);
        res.json({ success: true, clinics: result.rows });
    } catch (err) {
        console.error("Error searching clinics:", err);
        res.status(500).json({ success: false, message: "Error searching clinics." });
    }
});

// --- Appointment Booking ---
app.post("/api/appointments/book", async (req, res) => {
    const { patientId, doctorId, clinicId, date, scheduleId } = req.body; // Added scheduleId
    try {
        // 1. Check if patient already booked with this doctor on this day
        const existingAppointment = await db.query(
            "SELECT id FROM appointments WHERE patient_id = $1 AND doctor_id = $2 AND date = $3",
            [patientId, doctorId, date]
        );
        if (existingAppointment.rows.length > 0) {
            return res.status(400).json({ success: false, message: "You already have an appointment with this doctor on this day." });
        }

        // 2. Fetch schedule details using scheduleId to check limit and get times
        const scheduleRes = await db.query("SELECT * FROM doctor_schedules WHERE id = $1 AND doctor_id = $2 AND clinic_id = $3", [scheduleId, doctorId, clinicId]);
        if (scheduleRes.rows.length === 0) {
             return res.status(400).json({ success: false, message: "Selected schedule slot not found or invalid." });
        }
        const schedule = scheduleRes.rows[0];

        // 3. Check patient limit for THIS specific schedule slot on THAT day
        if (schedule.patient_limit > 0) {
            const appointmentCountRes = await db.query(
                "SELECT COUNT(*) FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 AND date = $3", // Count for the whole day for now, might need refinement if limit is per slot
                [doctorId, clinicId, date]
            );
            const currentCount = parseInt(appointmentCountRes.rows[0].count);
            if (currentCount >= schedule.patient_limit) {
                return res.status(400).json({ success: false, message: "This schedule slot's appointment limit has been reached." });
            }
        }

        // 4. Calculate queue number and approximate time based on the specific schedule slot
        const queueNumber = await getNextQueueNumber(doctorId, date, clinicId);
        const start = new Date(`${date}T${schedule.start_time}`); // Use schedule's start time
        // Simple time calculation (can be improved)
        const consultationDuration = 15; // Assuming 15 minutes per patient
        start.setMinutes(start.getMinutes() + (queueNumber - 1) * consultationDuration);
        const approxTime = start.toTimeString().slice(0, 5);

        // 5. Insert the appointment
        const newAppRes = await db.query(
            `INSERT INTO appointments (patient_id, doctor_id, clinic_id, date, "time", status, queue_number)
             VALUES ($1, $2, $3, $4, $5, 'Confirmed', $6) RETURNING *`,
            [patientId, doctorId, clinicId, date, approxTime, queueNumber]
        );
        res.json({ success: true, appointment: newAppRes.rows[0] });

    } catch (err) {
        console.error("Booking error:", err);
        res.status(500).json({ success: false, message: "Error booking appointment." });
    }
});


// --- Receptionist Actions ---
app.post("/api/receptionist/handle-join-request", async (req, res) => {
    const { requestId, action } = req.body;
    try {
        const request = await db.query("SELECT * FROM clinic_join_requests WHERE id = $1", [requestId]).then(r => r.rows[0]);
        if (!request) return res.status(404).json({ success: false, message: 'Request not found.' });

        if (action === 'accept') {
            // Check for conflict before accepting
            const conflict = await checkScheduleConflict(request.doctor_id, request.start_time, request.end_time, request.days);
            if (conflict) {
                return res.status(400).json({ success: false, message: "Cannot accept. Doctor has a conflicting schedule at this time." });
            }
            // Insert into doctor_schedules
            await db.query(
                "INSERT INTO doctor_schedules (doctor_id, clinic_id, start_time, end_time, days, patient_limit) VALUES ($1, $2, $3, $4, $5, $6)",
                [request.doctor_id, request.clinic_id, request.start_time, request.end_time, request.days, request.patient_limit || 0] // Use patient_limit from request or default to 0
            );
            // Update request status
            await db.query("UPDATE clinic_join_requests SET status = 'accepted' WHERE id = $1", [requestId]);
            res.json({ success: true, message: 'Request accepted.' });
        } else if (action === 'delete' || action === 'reject') { // Allow 'reject' as well
            await db.query("UPDATE clinic_join_requests SET status = 'rejected' WHERE id = $1", [requestId]);
            res.json({ success: true, message: 'Request rejected.' });
        } else {
             res.status(400).json({ success: false, message: 'Invalid action.' });
        }
    } catch (err) {
         console.error("Error handling join request:", err);
        res.status(500).json({ success: false, message: 'Error handling join request.' });
    }
});

app.post("/api/receptionist/add-doctor", async (req, res) => {
    const { name, specialty, username, password, Phonenumber, startTime, endTime, days, patientLimit, clinicId } = req.body;

    if (!name || !username || !password || !startTime || !endTime || !days || !clinicId) {
        return res.status(400).json({ success: false, message: "Missing required fields for adding a new doctor." });
    }

    const client = await db.connect(); // Use client for transaction
    try {
        // Check if username already exists
        const existingDoctor = await client.query("SELECT id FROM doctors WHERE username = $1", [username]);
        if (existingDoctor.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Username already exists. Please choose a different one.' });
        }

        // Although conflict check might seem redundant for a *new* doctor, keep the structure
        // const conflict = await checkScheduleConflict(null, startTime, endTime, days.join(','));
        // if (conflict) {
        //     // This case shouldn't realistically happen for a new doctor, but included for completeness
        //     return res.status(400).json({ success: false, message: "Schedule conflict detected (this should not happen for a new doctor)." });
        // }

        await client.query('BEGIN'); // Start transaction

        // Insert into doctors table
        const newDoctorRes = await client.query(
            "INSERT INTO doctors (name, specialty, username, password, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            [name, specialty || null, username, password, Phonenumber || null] // Handle optional fields
        );
        const newDoctorId = newDoctorRes.rows[0].id;

        // Insert into doctor_schedules table
        await client.query(
            "INSERT INTO doctor_schedules (doctor_id, clinic_id, start_time, end_time, days, patient_limit) VALUES ($1, $2, $3, $4, $5, $6)",
            [newDoctorId, clinicId, startTime, endTime, Array.isArray(days) ? days.join(',') : days, patientLimit || 0] // Ensure days is a string, handle patientLimit
        );

        await client.query('COMMIT'); // Commit transaction
        res.json({ success: true, message: 'Doctor added successfully with schedule.' });

    } catch (err) {
        await client.query('ROLLBACK'); // Rollback transaction on error
        console.error("Error in /api/receptionist/add-doctor:", err);
        // Provide more specific error if possible
        if (err.code === '23505' && err.constraint && err.constraint.includes('username')) {
             res.status(400).json({ success: false, message: 'Username already exists. Please choose a different one.' });
        } else {
             res.status(500).json({ success: false, message: 'An internal error occurred. Could not add doctor.' });
        }
    } finally {
        client.release(); // Release client back to the pool
    }
});


app.post("/api/receptionist/invite-doctor", async (req, res) => {
    const { doctorId, startTime, endTime, days, patientLimit, clinicId } = req.body; // Added patientLimit

    if (!doctorId || !startTime || !endTime || !days || !clinicId) {
        return res.status(400).json({ success: false, message: "Missing required fields for invitation." });
    }

    try {
        // Check for potential schedule conflict *before* sending invite
        const conflict = await checkScheduleConflict(doctorId, startTime, endTime, Array.isArray(days) ? days.join(',') : days);
        if (conflict) {
            return res.status(400).json({ success: false, message: "Cannot send invite. The doctor already has a conflicting schedule at this time." });
        }

        // Check if an identical pending invitation already exists
        const existingInvite = await db.query(
            "SELECT id FROM receptionist_invitations WHERE doctor_id = $1 AND clinic_id = $2 AND start_time = $3 AND end_time = $4 AND days = $5",
            [doctorId, clinicId, startTime, endTime, Array.isArray(days) ? days.join(',') : days]
        );
        if (existingInvite.rows.length > 0) {
            return res.status(400).json({ success: false, message: "An identical invitation has already been sent to this doctor." });
        }

        // Insert invitation
        await db.query(
            "INSERT INTO receptionist_invitations (doctor_id, clinic_id, start_time, end_time, days, patient_limit) VALUES ($1, $2, $3, $4, $5, $6)",
            [doctorId, clinicId, startTime, endTime, Array.isArray(days) ? days.join(',') : days, patientLimit || 0] // Store patientLimit
        );
        res.json({ success: true, message: 'Invitation sent successfully.' });
    } catch (err) {
        console.error("Error in /api/receptionist/invite-doctor:", err);
        res.status(500).json({ success: false, message: 'Error sending invitation.' });
    }
});

// --- Doctor Actions ---
// ... (other doctor routes remain the same) ...

// --- Admin Actions ---
app.post('/api/admin/clinics', async (req, res) => {
    const { name, address, receptionist_name, receptionist_username, receptionist_password } = req.body;
    // Basic validation
    if (!name || !address) {
        return res.status(400).json({ success: false, message: 'Clinic name and address are required.' });
    }
    // If receptionist details are provided, ensure all are present
    if (receptionist_name || receptionist_username || receptionist_password) {
        if (!receptionist_name || !receptionist_username || !receptionist_password) {
             return res.status(400).json({ success: false, message: 'If adding a receptionist, name, username, and password are required.' });
        }
    }

    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const newClinicRes = await client.query(
            "INSERT INTO clinics (name, address) VALUES ($1, $2) RETURNING id",
            [name, address]
        );
        const newClinicId = newClinicRes.rows[0].id;

        if (receptionist_name && receptionist_username && receptionist_password) {
             // Check if receptionist username is unique before inserting
             const existingReceptionist = await client.query("SELECT id FROM receptionists WHERE username = $1", [receptionist_username]);
             if (existingReceptionist.rows.length > 0) {
                 throw new Error(`Receptionist username '${receptionist_username}' already exists.`); // Throw error to trigger rollback
             }
            await client.query(
                "INSERT INTO receptionists (name, username, password, clinic_id) VALUES ($1, $2, $3, $4)",
                [receptionist_name, receptionist_username, receptionist_password, newClinicId]
            );
        }
        await client.query('COMMIT');
        res.json({ success: true, message: 'Clinic added successfully.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error adding clinic:", err);
         // Provide specific error if it's the username conflict
         if (err.message && err.message.includes('already exists')) {
             res.status(400).json({ success: false, message: err.message });
         } else {
             res.status(500).json({ success: false, message: 'Error adding clinic.' });
         }
    } finally {
        client.release();
    }
});

app.post('/api/admin/doctors', async (req, res) => {
    const { name, specialty, username, password, phone, clinicId, startTime, endTime, days, patientLimit } = req.body;

    // Basic Validation
    if (!name || !username || !password) {
        return res.status(400).json({ success: false, message: "Doctor's name, username, and password are required." });
    }
    // If schedule details are provided, ensure all are present
    if (clinicId || startTime || endTime || days) {
        if (!clinicId || !startTime || !endTime || !days || !days.length) {
             return res.status(400).json({ success: false, message: "If assigning a schedule, clinic, start time, end time, and days are required." });
        }
    }

    const client = await db.connect();
    try {
         // Check if doctor username exists
         const existingDoctor = await client.query("SELECT id FROM doctors WHERE username = $1", [username]);
         if (existingDoctor.rows.length > 0) {
             return res.status(400).json({ success: false, message: `Doctor username '${username}' already exists.` });
         }

        await client.query('BEGIN');
        const newDoctorRes = await client.query(
            "INSERT INTO doctors (name, specialty, username, password, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            [name, specialty || null, username, password, phone || null]
        );
        const newDoctorId = newDoctorRes.rows[0].id;

        if (clinicId && startTime && endTime && days && days.length > 0) {
             // Check for schedule conflict before adding schedule
             const daysString = Array.isArray(days) ? days.join(',') : days; // Ensure days is a string
             const conflict = await checkScheduleConflict(newDoctorId, startTime, endTime, daysString); // Pass new doctor ID
             if (conflict) {
                 // Technically shouldn't happen for a new doctor, but good practice
                 throw new Error("Schedule conflict detected for the new doctor (this should not happen).");
             }
            await client.query(
                "INSERT INTO doctor_schedules (doctor_id, clinic_id, start_time, end_time, days, patient_limit) VALUES ($1, $2, $3, $4, $5, $6)",
                [newDoctorId, clinicId, startTime, endTime, daysString, patientLimit || 0] // Default patientLimit to 0 if not provided
            );
        }
        await client.query('COMMIT');
        res.json({ success: true, message: 'Doctor added successfully.' + (clinicId ? ' with schedule.' : '') });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in /api/admin/add-doctor:", err);
         if (err.message && err.message.includes('already exists')) {
             res.status(400).json({ success: false, message: err.message });
         } else {
            res.status(500).json({ success: false, message: 'Error adding doctor.' });
         }
    } finally {
        client.release();
    }
});


app.post('/api/admin/patients', async (req, res) => {
    const { name, dob, username, password, mobile } = req.body;
    // Basic Validation
    if (!name || !username || !password || !dob) {
         return res.status(400).json({ success: false, message: "Patient's name, DOB, username, and password are required." });
    }
    try {
        // Check if username or mobile exists
        const existingPatient = await db.query("SELECT id FROM patients WHERE username = $1 OR mobile = $2", [username, mobile || null]);
        if (existingPatient.rows.length > 0) {
             return res.status(400).json({ success: false, message: 'Patient username or mobile number already exists.' });
        }

        await db.query(
            "INSERT INTO patients (name, dob, username, password, mobile) VALUES ($1, $2, $3, $4, $5)",
            [name, dob, username, password, mobile || null] // Handle optional mobile
        );
        res.json({ success: true, message: 'Patient added successfully.' });
    } catch (err) {
        console.error("Error adding patient:", err);
         if (err.code === '23505') { // Unique constraint
             res.status(400).json({ success: false, message: 'Patient username or mobile number already exists.' });
         } else {
             res.status(500).json({ success: false, message: 'Error adding patient.' });
         }
    }
});


// ... (DELETE routes remain the same) ...

// --- Automated Tasks ---
async function deleteOldAppointments() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const formattedDate = yesterday.toISOString().slice(0, 10);

    console.log(`Running scheduled task: Deleting appointments before ${formattedDate}...`);
    try {
        const result = await db.query("DELETE FROM appointments WHERE date < $1", [formattedDate]);
        if (result.rowCount > 0) {
            console.log(`Successfully deleted ${result.rowCount} old appointments.`);
        } else {
            console.log("No old appointments to delete.");
        }
    } catch (err) {
        console.error("Error during scheduled deletion of old appointments:", err);
    }
}

// --- Server ---
app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
    
});