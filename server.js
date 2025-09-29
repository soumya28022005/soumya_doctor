import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import cors from "cors";

const app = express();
const port = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Database Connection ---
const db = new pg.Client({
    connectionString: "postgresql://clinic_db_tjsj_user:9Nz7PUeCl3M9KnuHdFMRmqZ6sthNNBe4@dpg-d37ef0mr433s73emj910-a.singapore-postgres.render.com/clinic_db_tjsj",
    ssl: { rejectUnauthorized: false }
});
db.connect();

let doctorQueueStatus = {};

// --- Helper Functions ---
async function getNextQueueNumber(doctorId, date, clinicId) {
    const result = await db.query(
        "SELECT COUNT(*) FROM appointments WHERE doctor_id = $1 AND date = $2 AND clinic_id = $3",
        [doctorId, date, clinicId]
    );
    return parseInt(result.rows[0].count) + 1;
}

// --- API ROUTES ---

// --- Auth ---
app.post("/api/login/:role", async (req, res) => {
    const { role } = req.params;
    const { username, password } = req.body;
    const tableName = `${role}s`;
    try {
        const result = await db.query(`SELECT * FROM ${tableName} WHERE username = $1 AND password = $2`, [username, password]);
        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.json({ success: false, message: "Invalid username or password." });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "Error logging in." });
    }
});

app.post("/api/signup/patient", async (req, res) => {
    const { name, dob, mobile, username, password } = req.body;
    try {
        const result = await db.query(
            "INSERT INTO patients (name, dob, mobile, username, password) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            [name, dob, mobile, username, password]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: "Username may already be taken." });
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
            const appointmentsRes = await db.query("SELECT a.*, p.dob FROM appointments a JOIN patients p ON a.patient_id = p.id WHERE a.patient_id = $1 ORDER BY a.date DESC, a.time ASC", [userId]);
            data.appointments = appointmentsRes.rows;
        } else if (role === 'doctor') {
            const today = new Date().toISOString().slice(0, 10);
            
            let appointmentsQuery = "SELECT a.*, p.dob FROM appointments a JOIN patients p ON a.patient_id = p.id WHERE a.doctor_id = $1 AND a.date >= $2 ORDER BY a.date ASC, a.queue_number ASC";
            let appointmentsParams = [userId, today];
            if (clinicId) {
                appointmentsQuery = "SELECT a.*, p.dob FROM appointments a JOIN patients p ON a.patient_id = p.id WHERE a.doctor_id = $1 AND a.date >= $2 AND a.clinic_id = $3 ORDER BY a.date ASC, a.queue_number ASC";
                appointmentsParams.push(clinicId);
            }
            
            const [appointmentsRes, schedulesRes, clinicsRes, requestsRes, invitationsRes] = await Promise.all([
                db.query(appointmentsQuery, appointmentsParams),
                db.query(`SELECT ds.*, c.name as clinic_name FROM doctor_schedules ds JOIN clinics c ON ds.clinic_id = c.id WHERE ds.doctor_id = $1`, [userId]),
                db.query("SELECT * FROM clinics ORDER BY name"),
                db.query("SELECT cjr.*, c.name as clinic_name FROM clinic_join_requests cjr JOIN clinics c ON cjr.clinic_id = c.id WHERE cjr.doctor_id = $1", [userId]),
                db.query(`SELECT ri.*, c.name as clinic_name FROM receptionist_invitations ri JOIN clinics c ON ri.clinic_id = c.id WHERE ri.doctor_id = $1`, [userId])
            ]);
            data = { ...data, appointments: appointmentsRes.rows, schedules: schedulesRes.rows, clinics: clinicsRes.rows, doctorRequests: requestsRes.rows, invitations: invitationsRes.rows };
        } else if (role === 'receptionist') {
            const user = userRes.rows[0];
            const [clinicRes, appointmentsRes, clinicDocsRes, allDocsRes, requestsRes, invitationsRes, patientsRes] = await Promise.all([
                 db.query("SELECT * FROM clinics WHERE id = $1", [user.clinic_id]),
                 db.query("SELECT a.*, p.name as patient_name, d.name as doctor_name FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id JOIN doctors d ON a.doctor_id = d.id WHERE a.clinic_id = $1 ORDER BY a.date DESC, a.time ASC", [user.clinic_id]),
                 db.query(`SELECT d.*, ds.start_time, ds.end_time, ds.days FROM doctors d JOIN doctor_schedules ds ON d.id = ds.doctor_id WHERE ds.clinic_id = $1`, [user.clinic_id]),
                 db.query("SELECT * FROM doctors ORDER BY name"),
                 db.query("SELECT cjr.*, d.name as doctor_name, d.specialty as doctor_specialty FROM clinic_join_requests cjr JOIN doctors d ON cjr.doctor_id = d.id WHERE cjr.clinic_id = $1 AND cjr.status = 'pending'", [user.clinic_id]),
                 db.query("SELECT * FROM receptionist_invitations WHERE receptionist_id = $1", [userId]),
                 db.query("SELECT * FROM patients ORDER BY name")
            ]);
            data = { ...data, clinic: clinicRes.rows[0], appointments: appointmentsRes.rows, doctors: clinicDocsRes.rows, allDoctors: allDocsRes.rows, joinRequests: requestsRes.rows, invitations: invitationsRes.rows, patients: patientsRes.rows };
        } else if (role === 'admin') {
             const [patientsRes, doctorsRes, clinicsRes, appointmentsRes, receptionistsRes] = await Promise.all([
                db.query("SELECT * FROM patients ORDER BY name"),
                db.query("SELECT * FROM doctors ORDER BY name"),
                db.query("SELECT c.*, r.name as receptionist_name, r.username as receptionist_username, r.password as receptionist_password FROM clinics c LEFT JOIN receptionists r ON c.id = r.clinic_id ORDER BY c.name"),
                db.query("SELECT a.*, p.name as patient_name, d.name as doctor_name FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id JOIN doctors d ON a.doctor_id = d.id ORDER BY a.date DESC"),
                db.query("SELECT * FROM receptionists ORDER BY name")
            ]);
            data = { ...data, patients: patientsRes.rows, doctors: doctorsRes.rows, clinics: clinicsRes.rows, appointments: appointmentsRes.rows, receptionists: receptionistsRes.rows };
        }
        res.json(data);
    } catch (err) {
        console.error("Dashboard error:", err);
        res.status(500).json({ success: false, message: `Error fetching ${role} data.` });
    }
});


// --- Search and General GET ---
app.get("/api/doctors", async (req, res) => {
    const { name, specialty, clinic, date } = req.query;
    try {
        const dayOfWeek = new Date(date).toLocaleDateString('en-US', { weekday: 'long' });

        let query = `SELECT DISTINCT d.id, d.name, d.specialty, d.phone 
                     FROM doctors d 
                     LEFT JOIN doctor_schedules ds ON d.id = ds.doctor_id 
                     LEFT JOIN clinics c ON ds.clinic_id = c.id 
                     WHERE ds.days LIKE $1`;
        let params = [`%${dayOfWeek}%`];
        let i = 2;
        if (name) { query += ` AND d.name ILIKE $${i++}`; params.push(`%${name}%`); }
        if (specialty) { query += ` AND d.specialty ILIKE $${i++}`; params.push(`%${specialty}%`); }
        if (clinic) { query += ` AND c.name ILIKE $${i++}`; params.push(`%${clinic}%`); }
        query += " ORDER BY d.name";
        
        const doctorsResult = await db.query(query, params);
        
        for (let doctor of doctorsResult.rows) {
            const scheduleRes = await db.query(`SELECT ds.*, c.name as clinic_name FROM doctor_schedules ds JOIN clinics c ON ds.clinic_id = c.id WHERE ds.doctor_id = $1 AND ds.days LIKE $2`, [doctor.id, `%${dayOfWeek}%`]);
            doctor.schedules = scheduleRes.rows;
        }
        res.json({ success: true, doctors: doctorsResult.rows });
    } catch (err) {
        console.error("Doctor search error:", err);
        res.status(500).json({ success: false, message: "Error searching doctors." });
    }
});

app.get("/api/clinics/search", async (req, res) => {
    const { name } = req.query;
    try {
        const result = await db.query("SELECT id, name, address FROM clinics WHERE name ILIKE $1", [`%${name}%`]);
        res.json({ success: true, clinics: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: "Error searching clinics." });
    }
});

// --- Appointment Booking ---
app.post("/api/appointments/book", async (req, res) => {
    const { patientId, doctorId, clinicId, date } = req.body;

    // Server-side validation for past dates
    const today = new Date().toLocaleDateString('en-CA'); // Gets date in YYYY-MM-DD format
    if (date < today) {
        return res.status(400).json({ success: false, message: "Cannot book appointments for past dates." });
    }

    try {
        const [doctor, patient, clinic, schedule] = await Promise.all([
            db.query("SELECT * FROM doctors WHERE id = $1", [doctorId]).then(r => r.rows[0]),
            db.query("SELECT * FROM patients WHERE id = $1", [patientId]).then(r => r.rows[0]),
            db.query("SELECT * FROM clinics WHERE id = $1", [clinicId]).then(r => r.rows[0]),
            db.query("SELECT * FROM doctor_schedules WHERE doctor_id = $1 AND clinic_id = $2", [doctorId, clinicId]).then(r => r.rows[0])
        ]);

        if (doctor.daily_patient_limit > 0) {
            const appointmentCountRes = await db.query("SELECT COUNT(*) FROM appointments WHERE doctor_id = $1 AND date = $2", [doctorId, date]);
            const currentCount = parseInt(appointmentCountRes.rows[0].count);
            if (currentCount >= doctor.daily_patient_limit) {
                return res.status(400).json({ success: false, message: "Doctor's daily appointment limit has been reached." });
            }
        }
        
        if (!schedule) return res.status(400).json({ success: false, message: "Doctor does not have a schedule at this clinic." });
        const queueNumber = await getNextQueueNumber(doctorId, date, clinicId);
        const start = new Date(`${date}T${schedule.start_time}`);
        start.setMinutes(start.getMinutes() + (queueNumber - 1) * (doctor.consultation_duration || 15));
        const approxTime = start.toTimeString().slice(0, 5);
        const newApp = await db.query(`INSERT INTO appointments (patient_id, patient_name, doctor_id, doctor_name, clinic_id, clinic_name, date, "time", status, queue_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Confirmed', $9) RETURNING *`, [patient.id, patient.name, doctor.id, doctor.name, clinic.id, clinic.name, date, approxTime, queueNumber]);
        res.json({ success: true, appointment: newApp.rows[0] });
    } catch (err) {
        console.error("Booking error:", err);
        res.status(500).json({ success: false, message: "Error booking appointment." });
    }
});

// --- All other routes (receptionist, doctor, admin actions) remain the same... ---

// --- Receptionist Actions ---
app.post("/api/receptionist/book", async (req, res) => {
    const { patientId, doctorId, clinicId, date } = req.body;
    try {
        const [doctor, patient, clinic, schedule] = await Promise.all([
            db.query("SELECT * FROM doctors WHERE id = $1", [doctorId]).then(r => r.rows[0]),
            db.query("SELECT * FROM patients WHERE id = $1", [patientId]).then(r => r.rows[0]),
            db.query("SELECT * FROM clinics WHERE id = $1", [clinicId]).then(r => r.rows[0]),
            db.query("SELECT * FROM doctor_schedules WHERE doctor_id = $1 AND clinic_id = $2", [doctorId, clinicId]).then(r => r.rows[0])
        ]);

        if (!schedule) return res.status(400).json({ success: false, message: "Doctor does not have a schedule at this clinic." });
        
        const queueNumber = await getNextQueueNumber(doctorId, date, clinicId);
        const start = new Date(`${date}T${schedule.start_time}`);
        start.setMinutes(start.getMinutes() + (queueNumber - 1) * (doctor.consultation_duration || 15));
        const approxTime = start.toTimeString().slice(0, 5);
        
        const newApp = await db.query(`INSERT INTO appointments (patient_id, patient_name, doctor_id, doctor_name, clinic_id, clinic_name, date, "time", status, queue_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Confirmed', $9) RETURNING *`, [patient.id, patient.name, doctor.id, doctor.name, clinic.id, clinic.name, date, approxTime, queueNumber]);
        res.json({ success: true, appointment: newApp.rows[0] });
    } catch (err) {
        console.error("Receptionist booking error:", err);
        res.status(500).json({ success: false, message: "Error booking appointment." });
    }
});

app.post("/api/receptionist/handle-join-request", async (req, res) => {
    const { requestId, action } = req.body;
    try {
        if (action === 'accept') {
            const request = await db.query("SELECT * FROM clinic_join_requests WHERE id = $1", [requestId]).then(r => r.rows[0]);
            if (request) {
                await db.query("INSERT INTO doctor_schedules (doctor_id, clinic_id, start_time, end_time, days) VALUES ($1, $2, $3, $4, $5)",
                    [request.doctor_id, request.clinic_id, request.start_time, request.end_time, request.days]);
                await db.query("UPDATE clinic_join_requests SET status = 'accepted' WHERE id = $1", [requestId]);
            }
        } else if (action === 'delete') {
            await db.query("UPDATE clinic_join_requests SET status = 'rejected' WHERE id = $1", [requestId]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error handling join request.' });
    }
});

app.post("/api/receptionist/add-doctor", async (req, res) => {
    const { name, specialty, username, password, Phonenumber, startTime, endTime, days, customSchedule = null, clinicId } = req.body;
    try {
        const newDoctor = await db.query("INSERT INTO doctors (name, specialty, username, password, phone) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            [name, specialty, username, password, Phonenumber]).then(r => r.rows[0]);
        await db.query("INSERT INTO doctor_schedules (doctor_id, clinic_id, start_time, end_time, days, custom_schedule) VALUES ($1, $2, $3, $4, $5, $6)",
            [newDoctor.id, clinicId, startTime, endTime, days.join(','), customSchedule]);
        res.json({ success: true });
    } catch (err) {
        console.error("Error in /api/receptionist/add-doctor:", err); // Added for better debugging
        res.status(500).json({ success: false, message: 'Error adding new doctor.' });
    }
});

app.post("/api/receptionist/invite-doctor", async (req, res) => {
    const { doctorId, startTime, endTime, days, clinicId } = req.body; // customSchedule removed
    try {
        // "custom_schedule" and its value ($6) have been removed from the query
        await db.query("INSERT INTO receptionist_invitations (doctor_id, clinic_id, start_time, end_time, days) VALUES ($1, $2, $3, $4, $5)",
            [doctorId, clinicId, startTime, endTime, days.join(',')]);
        res.json({ success: true });
    } catch (err) {
        console.error("Error in /api/receptionist/invite-doctor:", err); 
        res.status(500).json({ success: false, message: 'Error inviting doctor.' });
    }
});

app.post("/api/receptionist/delete-doctor", async (req, res) => {
    const { doctorId, clinicId } = req.body;
    try {
        await db.query("DELETE FROM doctor_schedules WHERE doctor_id = $1 AND clinic_id = $2", [doctorId, clinicId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error deleting doctor from clinic.' });
    }
});

// --- Doctor Actions ---

app.post("/api/doctor/join-clinic", async (req, res) => {
    const { doctorId, clinicId, startTime, endTime, days } = req.body;
    try {
        // Check if a request already exists
        const existingRequest = await db.query(
            "SELECT * FROM clinic_join_requests WHERE doctor_id = $1 AND clinic_id = $2 AND status = 'pending'",
            [doctorId, clinicId]
        );

        if (existingRequest.rows.length > 0) {
            return res.json({ success: false, message: "You have already sent a join request to this clinic." });
        }

        await db.query(
            "INSERT INTO clinic_join_requests (doctor_id, clinic_id, start_time, end_time, days, status) VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *",
            [doctorId, clinicId, startTime, endTime, days.join(',')]
        );
        res.json({ success: true, message: "Join request sent successfully." });
    } catch (err) {
        console.error("Error sending join request:", err);
        res.status(500).json({ success: false, message: "Error sending join request." });
    }
});

app.post("/api/doctor/create-clinic", async (req, res) => {
    const { doctorId, name, address, startTime, endTime, days } = req.body;
    try {
        const newClinic = await db.query(
            "INSERT INTO clinics (name, address) VALUES ($1, $2) RETURNING *",
            [name, address]
        ).then(r => r.rows[0]);

        await db.query(
            "INSERT INTO doctor_schedules (doctor_id, clinic_id, start_time, end_time, days) VALUES ($1, $2, $3, $4, $5)",
            [doctorId, newClinic.id, startTime, endTime, days.join(',')]
        );

        res.json({ success: true, message: "Private clinic created and added to your schedule." });
    } catch (err) {
        console.error("Error creating private clinic:", err);
        res.status(500).json({ success: false, message: "Error creating private clinic." });
    }
});

app.post("/api/doctor/handle-invitation", async (req, res) => {
    const { invitationId, action } = req.body;
    try {
        if (action === 'accept') {
            const invitation = await db.query("SELECT * FROM receptionist_invitations WHERE id = $1", [invitationId]).then(r => r.rows[0]);
            if (invitation) {
                await db.query("INSERT INTO doctor_schedules (doctor_id, clinic_id, start_time, end_time, days) VALUES ($1, $2, $3, $4, $5)",
                    [invitation.doctor_id, invitation.clinic_id, invitation.start_time, invitation.end_time, invitation.days]);
                await db.query("DELETE FROM receptionist_invitations WHERE id = $1", [invitationId]);
                 res.json({ success: true, message: 'Invitation accepted.' });
            } else {
                 res.status(404).json({ success: false, message: 'Invitation not found.' });
            }
        } else if (action === 'delete') {
            await db.query("DELETE FROM receptionist_invitations WHERE id = $1", [invitationId]);
            res.json({ success: true, message: 'Invitation deleted.' });
        } else {
            res.status(400).json({ success: false, message: 'Invalid action.' });
        }
    } catch (err) {
        console.error("Error handling invitation:", err);
        res.status(500).json({ success: false, message: 'Error handling invitation.' });
    }
});
app.post("/api/doctor/next-patient", async (req, res) => {
    const { doctorId, clinicId } = req.body;
    const today = new Date().toISOString().slice(0, 10);

    try {
        const result = await db.query(
            `SELECT * FROM appointments
             WHERE doctor_id = $1
             AND clinic_id = $2
             AND date = $3
             AND status NOT IN ('Done', 'Absent')
             ORDER BY queue_number ASC
             LIMIT 1`,
            [doctorId, clinicId, today]
        );

        if (result.rows.length > 0) {
            const appointmentToUpdate = result.rows[0];
            await db.query(
                "UPDATE appointments SET status = 'Done' WHERE id = $1",
                [appointmentToUpdate.id]
            );

            const queueKey = `${doctorId}_${clinicId}`;
            if (!doctorQueueStatus[queueKey] || doctorQueueStatus[queueKey].date !== today) {
                 const totalResult = await db.query(
                     "SELECT COUNT(*) FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 AND date = $3",
                     [doctorId, clinicId, today]
                 );
                doctorQueueStatus[queueKey] = {
                    date: today,
                    currentNumber: 0,
                    totalPatients: parseInt(totalResult.rows[0].count)
                };
            }
            doctorQueueStatus[queueKey].currentNumber = appointmentToUpdate.queue_number;

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
    const { doctorId, clinicId } = req.params;
    const today = new Date().toISOString().slice(0, 10);

    try {
        const doneStatusRes = await db.query(
            `SELECT MAX(queue_number) as current_number FROM appointments
             WHERE doctor_id = $1 AND clinic_id = $2 AND date = $3 AND status = 'Done'`,
            [doctorId, clinicId, today]
        );

        const currentNumber = parseInt(doneStatusRes.rows[0].current_number) || 0;

        res.json({
            success: true,
            currentNumber: currentNumber,
        });

    } catch (err) {
        console.error("API /api/queue-status error:", err);
        res.status(500).json({ success: false, message: "Failed to get queue status" });
    }
});

app.delete("/api/doctor/:doctorId/appointments/today", async (req, res) => {
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

app.post("/api/doctor/settings", async (req, res) => {
    const { doctorId, dailyPatientLimit } = req.body;
    try {
        await db.query("UPDATE doctors SET daily_patient_limit = $1 WHERE id = $2", [dailyPatientLimit, doctorId]);
        res.json({ success: true, message: "Settings updated successfully." });
    } catch (err) {
        console.error("Error updating settings:", err);
        res.status(500).json({ success: false, message: "Error updating settings." });
    }
});

app.post("/api/doctor/:doctorId/queue/reset", async (req, res) => {
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

app.post("/api/doctor/delete-clinic", async (req, res) => {
    const { doctorId, clinicId } = req.body;
    try {
        await db.query("DELETE FROM doctor_schedules WHERE doctor_id = $1 AND clinic_id = $2", [doctorId, clinicId]);
        res.json({ success: true, message: 'Clinic schedule deleted successfully.' });
    } catch (err) {
        console.error("Error deleting clinic schedule:", err);
        res.status(500).json({ success: false, message: 'Error deleting clinic from schedule.' });
    }
});

app.delete("/api/appointments/:appointmentId", async (req, res) => {
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
    const { patientName, patientAge, doctorId, clinicId } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    try {
        const newPatient = await db.query(
            "INSERT INTO patients (name, dob, username, password) VALUES ($1, $2, $3, $4) RETURNING *",
            [patientName, new Date(new Date().setFullYear(new Date().getFullYear() - patientAge)), `${patientName.replace(/\s/g, '').toLowerCase()}${patientAge}${Date.now()}`, 'password123']
        ).then(r => r.rows[0]);

        const [doctor, clinic, schedule] = await Promise.all([
            db.query("SELECT * FROM doctors WHERE id = $1", [doctorId]).then(r => r.rows[0]),
            db.query("SELECT * FROM clinics WHERE id = $1", [clinicId]).then(r => r.rows[0]),
            db.query("SELECT * FROM doctor_schedules WHERE doctor_id = $1 AND clinic_id = $2", [doctorId, clinicId]).then(r => r.rows[0])
        ]);

        if (!schedule) return res.status(400).json({ success: false, message: "Doctor does not have a schedule at this clinic." });
        
        const queueNumber = await getNextQueueNumber(doctorId, today, clinicId);
        const start = new Date(`${today}T${schedule.start_time}`);
        start.setMinutes(start.getMinutes() + (queueNumber - 1) * (doctor.consultation_duration || 15));
        const approxTime = start.toTimeString().slice(0, 5);
        
        const newApp = await db.query(`INSERT INTO appointments (patient_id, patient_name, doctor_id, doctor_name, clinic_id, clinic_name, date, "time", status, queue_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Confirmed', $9) RETURNING *`, [newPatient.id, newPatient.name, doctor.id, doctor.name, clinic.id, clinic.name, today, approxTime, queueNumber]);
        res.json({ success: true, appointment: newApp.rows[0] });
    } catch (err) {
        console.error("Receptionist booking error:", err);
        res.status(500).json({ success: false, message: "Error booking appointment." });
    }
});

// --- Admin Actions ---
app.post('/api/admin/clinics', async (req, res) => {
    const { name, address, receptionist_name, receptionist_username, receptionist_password } = req.body;
    try {
        const newClinic = await db.query(
            "INSERT INTO clinics (name, address) VALUES ($1, $2) RETURNING *",
            [name, address]
        ).then(r => r.rows[0]);

        if (receptionist_name && receptionist_username && receptionist_password) {
            await db.query(
                "INSERT INTO receptionists (name, username, password, clinic_id) VALUES ($1, $2, $3, $4)",
                [receptionist_name, receptionist_username, receptionist_password, newClinic.id]
            );
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error adding clinic.' });
    }
});

app.post('/api/admin/doctors', async (req, res) => {
    const { name, specialty, username, password, phone, clinicId, startTime, endTime, days } = req.body;
    try {
        const newDoctor = await db.query(
            "INSERT INTO doctors (name, specialty, username, password, phone) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            [name, specialty, username, password, phone]
        ).then(r => r.rows[0]);

        if (clinicId && startTime && endTime && days) {
            await db.query(
                "INSERT INTO doctor_schedules (doctor_id, clinic_id, start_time, end_time, days) VALUES ($1, $2, $3, $4, $5)",
                [newDoctor.id, clinicId, startTime, endTime, days.join(',')]
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error("Error in /api/admin/add-doctor:", err);
        res.status(500).json({ success: false, message: 'Error adding doctor.' });
    }
});

app.post('/api/admin/patients', async (req, res) => {
    const { name, dob, username, password, mobile } = req.body;
    try {
        await db.query("INSERT INTO patients (name, dob, username, password, mobile) VALUES ($1, $2, $3, $4, $5)", [name, dob, username, password, mobile]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error adding patient.' });
    }
});

// --- Scheduled Tasks ---
async function deleteOldAppointments() {
    console.log('Running scheduled job to delete old appointments...');
    try {
        // Deletes appointments with a date before today.
        const result = await db.query("DELETE FROM appointments WHERE date < CURRENT_DATE");
        if (result.rowCount > 0) {
            console.log(`Successfully deleted ${result.rowCount} old appointments.`);
        } else {
            console.log('No old appointments to delete.');
        }
    } catch (err) {
        console.error('Error during scheduled deletion of old appointments:', err);
    }
}

// Run the cleanup task every 24 hours.
setInterval(deleteOldAppointments, 24 * 60 * 60 * 1000); 
// Also run it once on server startup.
deleteOldAppointments();
           
// --- Server ---
app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
});
