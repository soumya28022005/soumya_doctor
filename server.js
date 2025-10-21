import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import cors from "cors";

const { Pool } = pg; // Use Pool for better connection management
const app = express();
const port = process.env.PORT || 3000; // Use environment variable or default

// --- Middleware ---
// --- Middleware ---

// Explicit CORS Configuration
const corsOptions = {
  origin: "*", // Shob origin allow korun (development-er jonno)
  methods: "GET,POST,PUT,DELETE,PATCH,OPTIONS", // POST ebong OPTIONS allow kora khub joruri
  allowedHeaders: "Content-Type, Authorization" // Ei header-guli allow korun
};

app.use(cors(corsOptions));

// Browser-er preflight (OPTIONS) request-gulike handle korar jonno
app.options('*', cors(corsOptions)); 

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Database Connection ---
const db = new Pool({
    // Replace with your actual Supabase connection string
    connectionString: "postgresql://postgres:Soumya2802@@db.rancgomqjngwawhbuymy.supabase.co:5432/postgres",
    ssl: { rejectUnauthorized: false },
    family: 4 // <-- Ei line-ti add korun (Force connection over IPv4)
});

// Test DB connection on startup (optional but recommende)
db.connect((err, client, release) => {
    if (err) {
        return console.error('Error acquiring client', err.stack);
    }
    client.query('SELECT NOW()', (err, result) => {
        release(); // Release the client back to the poolk
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

// Function to check for schedule conflicts (Improved)
async function checkScheduleConflict(doctorId, startTime, endTime, daysString, scheduleIdToExclude = null) {
    console.log(`Checking conflict for Doctor ID: ${doctorId}, Start: ${startTime}, End: ${endTime}, Days: ${daysString}, Exclude ID: ${scheduleIdToExclude}`); // Added Log
    if (!doctorId) {
        console.log("No Doctor ID provided for conflict check, skipping.");
        return false; // Cannot check conflict without a doctor ID
    }
    // Use the pool directly to query
    let query = 'SELECT * FROM doctor_schedules WHERE doctor_id = $1';
    const params = [doctorId];
    if (scheduleIdToExclude) {
        query += ' AND id != $2';
        params.push(scheduleIdToExclude);
    }
    const { rows: existingSchedules } = await db.query(query, params);
    console.log(`Found ${existingSchedules.length} existing schedules for doctor ${doctorId}.`); // Added Log

    // Determine the type of the new schedule (weekly or monthly)
    const isNewScheduleMonthly = daysString.startsWith('DATE:');
    const newDaysOrDates = isNewScheduleMonthly ? daysString.substring(5).split(',') : daysString.split(',');

    for (const schedule of existingSchedules) {
        console.log(`Comparing with existing schedule ID: ${schedule.id}, Days: ${schedule.days}`); // Added Log
        const isExistingScheduleMonthly = schedule.days.startsWith('DATE:');
        const existingDaysOrDates = isExistingScheduleMonthly ? schedule.days.substring(5).split(',') : schedule.days.split(',');

        let daysOverlap = false;
        // Check for overlap only if types match (both weekly or both monthly)
        // Note: A more complex check might be needed if you want to prevent weekly/monthly overlaps on the same day number,
        // but for now, we'll keep it simpler: weekly only conflicts with weekly, monthly only with monthly.
        if (isNewScheduleMonthly === isExistingScheduleMonthly) {
            daysOverlap = newDaysOrDates.some(dayOrDate => existingDaysOrDates.includes(dayOrDate));
            console.log(`Overlap type match. Days/Dates overlap: ${daysOverlap}`); // Added Log
        } else {
             console.log("Schedule types don't match, skipping day/date overlap check for this pair."); // Added Log
        }


        if (daysOverlap) {
            // Check for time overlap only if days/dates overlap
            const existingStart = schedule.start_time;
            const existingEnd = schedule.end_time;
            console.log(`Checking time overlap: New(${startTime}-${endTime}) vs Existing(${existingStart}-${existingEnd})`); // Added Log
            // Overlap condition: (StartA < EndB) and (EndA > StartB)
            if (startTime < existingEnd && endTime > existingStart) {
                console.log("!!! Conflict Found !!!"); // Added Log
                return true; // Conflict found
            }
        }
    }
    console.log("--- No Conflict Found ---"); // Added Log
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
                    SELECT d.id, d.name, d.specialty, ds.id as schedule_id, ds.start_time, ds.end_time, ds.days, ds.patient_limit -- Include schedule_id
                    FROM doctors d
                    JOIN doctor_schedules ds ON d.id = ds.doctor_id
                    WHERE ds.clinic_id = $1 ORDER BY d.name, ds.start_time`, // Order by doctor then time
                    [user.clinic_id]),
                 db.query("SELECT id, name, phone FROM doctors ORDER BY name"), // Fetch all doctors for inviting
                 db.query("SELECT cjr.*, d.name as doctor_name, d.specialty as doctor_specialty FROM clinic_join_requests cjr JOIN doctors d ON cjr.doctor_id = d.id WHERE cjr.clinic_id = $1 AND cjr.status = 'pending'", [user.clinic_id]),
                 // Fetch pending invitations sent *by* this clinic
                 db.query("SELECT ri.*, d.name as doctor_name FROM receptionist_invitations ri JOIN doctors d ON ri.doctor_id = d.id WHERE ri.clinic_id = $1", [user.clinic_id]),
                 db.query("SELECT id, name, dob, mobile FROM patients ORDER BY name") // Fetch patients for booking
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

        // Join schedules and clinics if filtering by clinic or date
        if (clinic || date) {
            joinClauses += ` JOIN doctor_schedules ds ON d.id = ds.doctor_id`;
             if(clinic){
                 joinClauses += ` JOIN clinics c ON ds.clinic_id = c.id`;
                 whereClauses.push(`c.name ILIKE $${paramIndex++}`);
                 params.push(`%${clinic}%`);
             }
        }

        if (date) {
            const searchDate = new Date(date);
            const dayOfWeek = searchDate.toLocaleString('en-us', { weekday: 'long' });
            // Handle both weekly and monthly date formats in WHERE clause
            whereClauses.push(`(
                (ds.days NOT LIKE 'DATE:%' AND ds.days LIKE '%' || $${paramIndex++} || '%')
            )`);
             // Removed monthly date check from main query for simplicity, handle in schedule fetch
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

        // console.log("Doctor Search Query:", query); // Log query for debugging
        // console.log("Doctor Search Params:", params); // Log params for debugging

        const doctorsResult = await db.query(query, params);

        // Fetch available schedules for the found doctors ON THE SPECIFIED DATE
        if (date) {
            const searchDateObj = new Date(date);
            const dayOfWeek = searchDateObj.toLocaleString('en-us', { weekday: 'long' });
            // const dateOfMonth = searchDateObj.getDate().toString(); // For monthly check

            for (let doctor of doctorsResult.rows) {
                // Fetch schedules matching the day or date
                const scheduleRes = await db.query(
                    `SELECT ds.id as schedule_id, ds.clinic_id, ds.start_time, ds.end_time, ds.patient_limit, c.name as clinic_name
                     FROM doctor_schedules ds
                     JOIN clinics c ON ds.clinic_id = c.id
                     WHERE ds.doctor_id = $1 AND (
                         (ds.days NOT LIKE 'DATE:%' AND ds.days LIKE '%' || $2 || '%')
                     )`, // Simplified: only check weekly for now in this query
                    [doctor.id, dayOfWeek]
                );

                 // Check appointment count against patient_limit for each valid schedule slot
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
    // scheduleId is now required from frontend for accurate limit check
    const { patientId, doctorId, clinicId, date, scheduleId } = req.body;

    if (!patientId || !doctorId || !clinicId || !date || !scheduleId) {
         return res.status(400).json({ success: false, message: "Missing required information for booking." });
    }

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
        const scheduleRes = await db.query(
            "SELECT start_time, patient_limit FROM doctor_schedules WHERE id = $1 AND doctor_id = $2 AND clinic_id = $3",
             [scheduleId, doctorId, clinicId]
        );
        if (scheduleRes.rows.length === 0) {
             return res.status(400).json({ success: false, message: "Selected schedule slot not found or invalid." });
        }
        const schedule = scheduleRes.rows[0];

        // 3. Check patient limit FOR THIS schedule slot on THAT day/timeframe
        // Note: Current check is still day-based, needs refinement for slot-based limit if required.
        if (schedule.patient_limit > 0) {
            const appointmentCountRes = await db.query(
                "SELECT COUNT(*) FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 AND date = $3", // Counts appointments for the entire day at the clinic
                [doctorId, clinicId, date]
            );
            const currentCount = parseInt(appointmentCountRes.rows[0].count);
            if (currentCount >= schedule.patient_limit) {
                return res.status(400).json({ success: false, message: "This schedule slot's appointment limit has been reached for the day." });
            }
        }

        // 4. Calculate queue number and approximate time
        const queueNumber = await getNextQueueNumber(doctorId, date, clinicId);
        const start = new Date(`${date}T${schedule.start_time}`); // Use schedule's start time
        const consultationDuration = 15; // Assume 15 minutes
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
    console.log(">>>> Received request on /api/receptionist/handle-join-request"); // Added Log
    const { requestId, action } = req.body;
    console.log(`Data: requestId=${requestId}, action=${action}`); // Added Log
    try {
        const request = await db.query("SELECT * FROM clinic_join_requests WHERE id = $1", [requestId]).then(r => r.rows[0]);
        if (!request) {
            console.log("Join request not found for ID:", requestId); // Added Log
            return res.status(404).json({ success: false, message: 'Request not found.' });
        }
        console.log("Found request:", request); // Added Log

        if (action === 'accept') {
            console.log("Action is 'accept'. Checking conflict..."); // Added Log
            // Check for conflict before accepting
            const conflict = await checkScheduleConflict(request.doctor_id, request.start_time, request.end_time, request.days);
            if (conflict) {
                console.log("Conflict detected for doctor:", request.doctor_id); // Added Log
                return res.status(400).json({ success: false, message: "Cannot accept. Doctor has a conflicting schedule at this time." });
            }
            console.log("No conflict found. Inserting into doctor_schedules..."); // Added Log
            // Insert into doctor_schedules
            await db.query(
                "INSERT INTO doctor_schedules (doctor_id, clinic_id, start_time, end_time, days, patient_limit) VALUES ($1, $2, $3, $4, $5, $6)",
                [request.doctor_id, request.clinic_id, request.start_time, request.end_time, request.days, request.patient_limit || 0] // Use patient_limit from request or default to 0
            );
            console.log("Inserted into schedules. Updating request status..."); // Added Log
            // Update request status
            await db.query("UPDATE clinic_join_requests SET status = 'accepted' WHERE id = $1", [requestId]);
            console.log("Request status updated to accepted."); // Added Log
            res.json({ success: true, message: 'Request accepted.' });
        } else if (action === 'delete' || action === 'reject') { // Allow 'reject' as well
             console.log(`Action is '${action}'. Updating request status to rejected...`); // Added Log
            await db.query("UPDATE clinic_join_requests SET status = 'rejected' WHERE id = $1", [requestId]);
            console.log("Request status updated to rejected."); // Added Log
            res.json({ success: true, message: 'Request rejected.' });
        } else {
             console.log("Invalid action received:", action); // Added Log
             res.status(400).json({ success: false, message: 'Invalid action.' });
        }
    } catch (err) {
         console.error("Error handling join request:", err);
        res.status(500).json({ success: false, message: 'Error handling join request.' });
    }
});


app.post("/api/receptionist/add-doctor", async (req, res) => {
    // ... (Code remains the same as previous version) ...
     const { name, specialty, username, password, Phonenumber, startTime, endTime, days, patientLimit, clinicId } = req.body;

    if (!name || !username || !password || !startTime || !endTime || !days || !clinicId) {
        return res.status(400).json({ success: false, message: "Missing required fields for adding a new doctor." });
    }

    const client = await db.connect(); // Use client for transaction
    try {
        const existingDoctor = await client.query("SELECT id FROM doctors WHERE username = $1", [username]);
        if (existingDoctor.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Username already exists. Please choose a different one.' });
        }

        await client.query('BEGIN'); // Start transaction
        const newDoctorRes = await client.query(
            "INSERT INTO doctors (name, specialty, username, password, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            [name, specialty || null, username, password, Phonenumber || null]
        );
        const newDoctorId = newDoctorRes.rows[0].id;

        await client.query(
            "INSERT INTO doctor_schedules (doctor_id, clinic_id, start_time, end_time, days, patient_limit) VALUES ($1, $2, $3, $4, $5, $6)",
            [newDoctorId, clinicId, startTime, endTime, Array.isArray(days) ? days.join(',') : days, patientLimit || 0]
        );

        await client.query('COMMIT'); // Commit transaction
        res.json({ success: true, message: 'Doctor added successfully with schedule.' });

    } catch (err) {
        await client.query('ROLLBACK'); // Rollback transaction on error
        console.error("Error in /api/receptionist/add-doctor:", err);
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
    // ... (Code remains the same as previous version) ...
     const { doctorId, startTime, endTime, days, patientLimit, clinicId } = req.body;

    if (!doctorId || !startTime || !endTime || !days || !clinicId) {
        return res.status(400).json({ success: false, message: "Missing required fields for invitation." });
    }

    try {
        const conflict = await checkScheduleConflict(doctorId, startTime, endTime, Array.isArray(days) ? days.join(',') : days);
        if (conflict) {
            return res.status(400).json({ success: false, message: "Cannot send invite. The doctor already has a conflicting schedule at this time." });
        }

        const existingInvite = await db.query(
            "SELECT id FROM receptionist_invitations WHERE doctor_id = $1 AND clinic_id = $2 AND start_time = $3 AND end_time = $4 AND days = $5",
            [doctorId, clinicId, startTime, endTime, Array.isArray(days) ? days.join(',') : days]
        );
        if (existingInvite.rows.length > 0) {
            return res.status(400).json({ success: false, message: "An identical invitation has already been sent to this doctor." });
        }

        await db.query(
            "INSERT INTO receptionist_invitations (doctor_id, clinic_id, start_time, end_time, days, patient_limit) VALUES ($1, $2, $3, $4, $5, $6)",
            [doctorId, clinicId, startTime, endTime, Array.isArray(days) ? days.join(',') : days, patientLimit || 0]
        );
        res.json({ success: true, message: 'Invitation sent successfully.' });
    } catch (err) {
        console.error("Error in /api/receptionist/invite-doctor:", err);
        res.status(500).json({ success: false, message: 'Error sending invitation.' });
    }
});

// --- Doctor Actions ---
app.post("/api/doctor/join-clinic", async (req, res) => {
    console.log(">>>> Received request on /api/doctor/join-clinic"); // Added Log
    const { doctorId, clinicId, startTime, endTime, days, patientLimit } = req.body;
    console.log("Request Data:", req.body); // Added Log

    // Basic Validation
     if (!doctorId || !clinicId || !startTime || !endTime || !days) {
         return res.status(400).json({ success: false, message: "Missing required fields for join request." });
     }

    try {
        console.log("Checking for schedule conflict..."); // Added Log
        const conflict = await checkScheduleConflict(doctorId, startTime, endTime, days);
        if (conflict) {
             console.log("Conflict detected."); // Added Log
            return res.status(400).json({ success: false, message: "Cannot send request. You have a conflicting schedule at this time." });
        }
         console.log("No conflict found. Checking for existing request..."); // Added Log

        const existingRequest = await db.query(
            "SELECT * FROM clinic_join_requests WHERE doctor_id = $1 AND clinic_id = $2 AND start_time = $3 AND end_time = $4 AND days = $5 AND status = 'pending'",
            [doctorId, clinicId, startTime, endTime, days]
        );
        if (existingRequest.rows.length > 0) {
             console.log("Identical request already exists."); // Added Log
            return res.json({ success: false, message: "You have already sent an identical join request to this clinic." });
        }

        console.log("Inserting new join request..."); // Added Log
        await db.query(
            "INSERT INTO clinic_join_requests (doctor_id, clinic_id, start_time, end_time, days, status, patient_limit) VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING *",
            [doctorId, clinicId, startTime, endTime, days, patientLimit || 0] // Use patient_limit or default 0
        );
        console.log("Join request inserted successfully."); // Added Log
        res.json({ success: true, message: "Join request sent successfully." });
    } catch (err) {
        console.error("Error sending join request:", err);
        res.status(500).json({ success: false, message: "Error sending join request." });
    }
});


app.post("/api/doctor/handle-invitation", async (req, res) => {
    console.log(">>>> Received request on /api/doctor/handle-invitation"); // Added Log
    const { invitationId, action } = req.body;
    console.log(`Data: invitationId=${invitationId}, action=${action}`); // Added Log
    try {
        console.log("Fetching invitation details..."); // Added Log
        const invitation = await db.query("SELECT * FROM receptionist_invitations WHERE id = $1", [invitationId]).then(r => r.rows[0]);
        if (!invitation) {
             console.log("Invitation not found for ID:", invitationId); // Added Log
            return res.status(404).json({ success: false, message: 'Invitation not found.' });
        }
         console.log("Found invitation:", invitation); // Added Log

        if (action === 'accept') {
            console.log("Action is 'accept'. Checking conflict..."); // Added Log
            const conflict = await checkScheduleConflict(invitation.doctor_id, invitation.start_time, invitation.end_time, invitation.days);
            if (conflict) {
                 console.log("Conflict detected for doctor:", invitation.doctor_id); // Added Log
                return res.status(400).json({ success: false, message: "Cannot accept. You have a conflicting schedule at this time." });
            }
            console.log("No conflict found. Inserting into doctor_schedules..."); // Added Log
            await db.query(
                "INSERT INTO doctor_schedules (doctor_id, clinic_id, start_time, end_time, days, patient_limit) VALUES ($1, $2, $3, $4, $5, $6)",
                [invitation.doctor_id, invitation.clinic_id, invitation.start_time, invitation.end_time, invitation.days, invitation.patient_limit || 0] // Use patient_limit
            );
            console.log("Inserted into schedules. Deleting invitation..."); // Added Log
            await db.query("DELETE FROM receptionist_invitations WHERE id = $1", [invitationId]);
            console.log("Invitation deleted."); // Added Log
            res.json({ success: true, message: 'Invitation accepted.' });
        } else if (action === 'delete') {
             console.log("Action is 'delete'. Deleting invitation..."); // Added Log
            await db.query("DELETE FROM receptionist_invitations WHERE id = $1", [invitationId]);
             console.log("Invitation deleted."); // Added Log
            res.json({ success: true, message: 'Invitation deleted.' });
        } else {
             console.log("Invalid action received:", action); // Added Log
             res.status(400).json({ success: false, message: 'Invalid action.' });
        }
    } catch (err) {
        console.error("Error handling invitation:", err);
        res.status(500).json({ success: false, message: 'Error handling invitation.' });
    }
});


// ... (Rest of the code remains the same as previous version) ...
app.post("/api/doctor/create-clinic", async (req, res) => {
    // ... code ...
     const { doctorId, name, address, startTime, endTime, days, patientLimit } = req.body;
    try {
        const conflict = await checkScheduleConflict(doctorId, startTime, endTime, days);
        if (conflict) {
            return res.status(400).json({ success: false, message: "Cannot create clinic schedule. You have a conflicting schedule at this time." });
        }
        const newClinic = await db.query("INSERT INTO clinics (name, address) VALUES ($1, $2) RETURNING *", [name, address]).then(r => r.rows[0]);
        await db.query("INSERT INTO doctor_schedules (doctor_id, clinic_id, start_time, end_time, days, patient_limit) VALUES ($1, $2, $3, $4, $5, $6)", [doctorId, newClinic.id, startTime, endTime, days, patientLimit || 0]); // Use patient_limit
        res.json({ success: true, message: "Private clinic created and added to your schedule." });
    } catch (err) {
        console.error("Error creating private clinic:", err);
        res.status(500).json({ success: false, message: "Error creating private clinic." });
    }
});

app.post("/api/doctor/next-patient", async (req, res) => {
    // ... code ...
     const { doctorId, clinicId } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    try {
        const result = await db.query(`SELECT * FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 AND date = $3 AND status NOT IN ('Done', 'Absent') ORDER BY queue_number ASC LIMIT 1`, [doctorId, clinicId, today]);
        if (result.rows.length > 0) {
            const appointmentToUpdate = result.rows[0];
            await db.query("UPDATE appointments SET status = 'Done' WHERE id = $1", [appointmentToUpdate.id]);
            res.json({ success: true, message: "Patient status updated to Done." });
        } else {
            res.json({ success: false, message: "No more patients in the queue." });
        }
    } catch (err) {
        console.error("Error in next-patient:", err);
        res.status(500).json({ success: false, message: "Error processing next patient." });
    }
});

app.get("/api/queue-status/:doctorId/:clinicId", async (req, res) => {
    // ... code ...
     const { doctorId, clinicId } = req.params;
    const today = new Date().toISOString().slice(0, 10);
    try {
        const doneStatusRes = await db.query(`SELECT MAX(queue_number) as current_number FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 AND date = $3 AND status = 'Done'`, [doctorId, clinicId, today]);
        const currentNumber = parseInt(doneStatusRes.rows[0].current_number) || 0;
        res.json({ success: true, currentNumber: currentNumber });
    } catch (err) {
        console.error("API /api/queue-status error:", err);
        res.status(500).json({ success: false, message: "Failed to get queue status" });
    }
});

app.delete("/api/doctor/:doctorId/appointments/today", async (req, res) => {
    // ... code ...
     const { doctorId } = req.params;
    const { clinicId } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    try {
        let query = "DELETE FROM appointments WHERE doctor_id = $1 AND date = $2";
        let params = [doctorId, today];
        if (clinicId) {
            query += " AND clinic_id = $3";
            params.push(clinicId);
        }
        await db.query(query, params);
        res.json({ success: true, message: "Selected appointments for today have been cleared." });
    } catch (err) {
        console.error("Error clearing appointments:", err);
        res.status(500).json({ success: false, message: "Error clearing appointments." });
    }
});

app.post("/api/doctor/:doctorId/queue/reset", async (req, res) => {
    // ... code ...
     const { doctorId } = req.params;
    const { clinicId } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    try {
        let query = "UPDATE appointments SET status = 'Confirmed' WHERE doctor_id = $1 AND date = $2 AND status = 'Done'";
        let params = [doctorId, today];
        if (clinicId) {
            query += " AND clinic_id = $3";
            params.push(clinicId);
        }
        await db.query(query, params);
        res.json({ success: true, message: "Queue has been reset for the selected clinic(s)." });
    } catch (err) {
        console.error("Error resetting queue:", err);
        res.status(500).json({ success: false, message: "Error resetting queue." });
    }
});

app.delete("/api/schedules/:scheduleId", async (req, res) => {
    // ... code ...
     const { scheduleId } = req.params;
    try {
        await db.query("DELETE FROM doctor_schedules WHERE id = $1", [scheduleId]);
        res.json({ success: true, message: 'Schedule slot deleted successfully.' });
    } catch (err) {
        console.error("Error deleting schedule slot:", err);
        res.status(500).json({ success: false, message: 'Error deleting schedule slot.' });
    }
});


app.delete("/api/appointments/:appointmentId", async (req, res) => {
    // ... code ...
     const { appointmentId } = req.params;
    try {
        await db.query("DELETE FROM appointments WHERE id = $1", [appointmentId]);
        res.json({ success: true, message: "Appointment cancelled successfully." });
    } catch (err) {
        console.error("Error cancelling appointment:", err);
        res.status(500).json({ success: false, message: "Error cancelling appointment." });
    }
});

app.post("/api/appointments/:appointmentId/status", async (req, res) => {
    // ... code ...
     const { appointmentId } = req.params;
    const { status } = req.body;
    try {
        await db.query("UPDATE appointments SET status = $1 WHERE id = $2", [status, appointmentId]);
        res.json({ success: true, message: "Appointment status updated." });
    } catch (err) {
        console.error("Error updating appointment status:", err);
        res.status(500).json({ success: false, message: "Error updating status." });
    }
});


app.post("/api/receptionist/add-patient-and-book", async (req, res) => {
    // ... code ...
     const { patientName, patientAge, doctorId, clinicId } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    try {
        const newPatient = await db.query("INSERT INTO patients (name, dob, username, password) VALUES ($1, $2, $3, $4) RETURNING *", [patientName, new Date(new Date().setFullYear(new Date().getFullYear() - patientAge)), `${patientName.replace(/\s/g, '').toLowerCase()}${patientAge}${Date.now()}`, 'password123']).then(r => r.rows[0]);
        const [doctor, schedule] = await Promise.all([
            db.query("SELECT * FROM doctors WHERE id = $1", [doctorId]).then(r => r.rows[0]),
            db.query("SELECT * FROM doctor_schedules WHERE doctor_id = $1 AND clinic_id = $2", [doctorId, clinicId]).then(r => r.rows[0]) // Assuming one schedule per doc/clinic for simplicity here
        ]);
        if (!schedule) return res.status(400).json({ success: false, message: "Doctor does not have a schedule at this clinic." });
        const queueNumber = await getNextQueueNumber(doctorId, today, clinicId);
        const start = new Date(`${today}T${schedule.start_time}`);
        start.setMinutes(start.getMinutes() + (queueNumber - 1) * 15);
        const approxTime = start.toTimeString().slice(0, 5);
        await db.query(`INSERT INTO appointments (patient_id, doctor_id, clinic_id, date, "time", status, queue_number) VALUES ($1, $2, $3, $4, $5, 'Confirmed', $6) RETURNING *`, [newPatient.id, doctor.id, clinicId, today, approxTime, queueNumber]);
        res.json({ success: true });
    } catch (err) {
        console.error("Receptionist booking error:", err);
        res.status(500).json({ success: false, message: "Error booking appointment." });
    }
});

// --- Admin Actions ---
app.post('/api/admin/clinics', async (req, res) => {
    // ... code ...
     const { name, address, receptionist_name, receptionist_username, receptionist_password } = req.body;
    if (!name || !address) {
        return res.status(400).json({ success: false, message: 'Clinic name and address are required.' });
    }
    if (receptionist_name || receptionist_username || receptionist_password) {
        if (!receptionist_name || !receptionist_username || !receptionist_password) {
             return res.status(400).json({ success: false, message: 'If adding a receptionist, name, username, and password are required.' });
        }
    }

    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const newClinicRes = await client.query("INSERT INTO clinics (name, address) VALUES ($1, $2) RETURNING id", [name, address]);
        const newClinicId = newClinicRes.rows[0].id;
        if (receptionist_name && receptionist_username && receptionist_password) {
             const existingReceptionist = await client.query("SELECT id FROM receptionists WHERE username = $1", [receptionist_username]);
             if (existingReceptionist.rows.length > 0) {
                 throw new Error(`Receptionist username '${receptionist_username}' already exists.`);
             }
            await client.query("INSERT INTO receptionists (name, username, password, clinic_id) VALUES ($1, $2, $3, $4)", [receptionist_name, receptionist_username, receptionist_password, newClinicId]);
        }
        await client.query('COMMIT');
        res.json({ success: true, message: 'Clinic added successfully.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error adding clinic:", err);
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
    // ... code ...
     const { name, specialty, username, password, phone, clinicId, startTime, endTime, days, patientLimit } = req.body;
    if (!name || !username || !password) {
        return res.status(400).json({ success: false, message: "Doctor's name, username, and password are required." });
    }
    if (clinicId || startTime || endTime || days) {
        if (!clinicId || !startTime || !endTime || !days || !days.length) {
             return res.status(400).json({ success: false, message: "If assigning a schedule, clinic, start time, end time, and days are required." });
        }
    }

    const client = await db.connect();
    try {
         const existingDoctor = await client.query("SELECT id FROM doctors WHERE username = $1", [username]);
         if (existingDoctor.rows.length > 0) {
             return res.status(400).json({ success: false, message: `Doctor username '${username}' already exists.` });
         }

        await client.query('BEGIN');
        const newDoctorRes = await client.query("INSERT INTO doctors (name, specialty, username, password, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id", [name, specialty || null, username, password, phone || null]);
        const newDoctorId = newDoctorRes.rows[0].id;
        if (clinicId && startTime && endTime && days && days.length > 0) {
             const daysString = Array.isArray(days) ? days.join(',') : days;
             const conflict = await checkScheduleConflict(newDoctorId, startTime, endTime, daysString);
             if (conflict) {
                 throw new Error("Schedule conflict detected for the new doctor (this should not happen).");
             }
            await client.query("INSERT INTO doctor_schedules (doctor_id, clinic_id, start_time, end_time, days, patient_limit) VALUES ($1, $2, $3, $4, $5, $6)", [newDoctorId, clinicId, startTime, endTime, daysString, patientLimit || 0]);
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
    // ... code ...
     const { name, dob, username, password, mobile } = req.body;
    if (!name || !username || !password || !dob) {
         return res.status(400).json({ success: false, message: "Patient's name, DOB, username, and password are required." });
    }
    try {
        const existingPatient = await db.query("SELECT id FROM patients WHERE username = $1 OR mobile = $2", [username, mobile || null]);
        if (existingPatient.rows.length > 0) {
             return res.status(400).json({ success: false, message: 'Patient username or mobile number already exists.' });
        }
        await db.query("INSERT INTO patients (name, dob, username, password, mobile) VALUES ($1, $2, $3, $4, $5)", [name, dob, username, password, mobile || null]);
        res.json({ success: true, message: 'Patient added successfully.' });
    } catch (err) {
        console.error("Error adding patient:", err);
         if (err.code === '23505') {
             res.status(400).json({ success: false, message: 'Patient username or mobile number already exists.' });
         } else {
             res.status(500).json({ success: false, message: 'Error adding patient.' });
         }
    }
});

// Delete Routes
app.delete('/api/admin/clinics/:id', async (req, res) => {
    // ... code ...
     const { id } = req.params;
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query("DELETE FROM doctor_schedules WHERE clinic_id = $1", [id]);
        await client.query("DELETE FROM appointments WHERE clinic_id = $1", [id]);
        await client.query("DELETE FROM clinic_join_requests WHERE clinic_id = $1", [id]);
        await client.query("DELETE FROM receptionist_invitations WHERE clinic_id = $1", [id]);
        await client.query("DELETE FROM receptionists WHERE clinic_id = $1", [id]);
        await client.query("DELETE FROM clinics WHERE id = $1", [id]);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Clinic and all associated data deleted.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error deleting clinic:", err);
        res.status(500).json({ success: false, message: 'Error deleting clinic.' });
    } finally {
        client.release();
    }
});

app.delete('/api/admin/doctors/:id', async (req, res) => {
    // ... code ...
     const { id } = req.params;
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query("DELETE FROM doctor_schedules WHERE doctor_id = $1", [id]);
        await client.query("DELETE FROM appointments WHERE doctor_id = $1", [id]);
        await client.query("DELETE FROM clinic_join_requests WHERE doctor_id = $1", [id]);
        await client.query("DELETE FROM receptionist_invitations WHERE doctor_id = $1", [id]);
        await client.query("DELETE FROM doctors WHERE id = $1", [id]);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Doctor and all associated data deleted.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error deleting doctor:", err);
        res.status(500).json({ success: false, message: 'Error deleting doctor.' });
    } finally {
        client.release();
    }
});

app.delete('/api/admin/patients/:id', async (req, res) => {
    // ... code ...
     const { id } = req.params;
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query("DELETE FROM appointments WHERE patient_id = $1", [id]);
        await client.query("DELETE FROM patients WHERE id = $1", [id]);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Patient and their appointments deleted.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error deleting patient:", err);
        res.status(500).json({ success: false, message: 'Error deleting patient.' });
    } finally {
        client.release();
    }
});

// --- Automated Tasks ---
async function deleteOldAppointments() {
    // ... code ...
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
    // Optional: Run cleanup once on startup
    // deleteOldAppointments();
    // Schedule to run every 24 hours
    // setInterval(deleteOldAppointments, 24 * 60 * 60 * 1000); // 24 hours
});

// Catch-all for unhandled errors (optional but good practice)
process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error', err);
  // process.exit(1); // Optional: exit if you want the server to stop on critical errors
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});