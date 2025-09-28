import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import cors from "cors";

const app = express();
const port = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors()); // Enable CORS for all routes, allowing frontend to connect
app.use(bodyParser.json()); // Important: Use JSON body parser for API requests
app.use(bodyParser.urlencoded({ extended: true }));

// --- Database Connection ---
const db = new pg.Client({
    connectionString: "postgresql://clinic_db_tjsj_user:9Nz7PUeCl3M9KnuHdFMRmqZ6sthNNBe4@dpg-d37ef0mr433s73emj910-a.singapore-postgres.render.com/clinic_db_tjsj",
    ssl: {
        rejectUnauthorized: false
    }
});

db.connect();

// --- Live Queue Tracking (In-Memory for speed) ---
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

// --- Auth Routes ---
app.post("/api/login/:role", async (req, res) => {
    const role = req.params.role;
    const { username, password } = req.body;
    let tableName;
    switch (role) {
        case 'patient': tableName = 'patients'; break;
        case 'doctor': tableName = 'doctors'; break;
        case 'receptionist': tableName = 'receptionists'; break;
        case 'admin': tableName = 'admins'; break;
        default: return res.status(400).json({ success: false, message: "Invalid role" });
    }
    try {
        const result = await db.query(`SELECT * FROM ${tableName} WHERE username = $1 AND password = $2`, [username, password]);
        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.json({ success: false, message: "Invalid username or password." });
        }
    } catch (err) {
        console.error("Login error:", err);
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
        console.error("Signup error:", err);
        res.status(500).json({ success: false, message: "Username may already be taken." });
    }
});

// --- Dashboard Data Routes ---
app.get("/api/dashboard/patient/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const patientResult = await db.query("SELECT * FROM patients WHERE id = $1", [userId]);
        if (patientResult.rows.length === 0) return res.status(404).json({ success: false, message: "Patient not found" });
        
        const appointmentsResult = await db.query("SELECT * FROM appointments WHERE patient_id = $1 ORDER BY date DESC, time ASC", [userId]);
        
        res.json({
            success: true,
            patient: patientResult.rows[0],
            appointments: appointmentsResult.rows
        });
    } catch (err) {
        console.error("Patient dashboard error:", err);
        res.status(500).json({ success: false, message: "Error fetching patient data." });
    }
});

app.get("/api/dashboard/doctor/:userId", async (req, res) => {
    const { userId } = req.params;
    const { clinicId } = req.query; 

    try {
        const doctorResult = await db.query("SELECT * FROM doctors WHERE id = $1", [userId]);
        if (doctorResult.rows.length === 0) return res.status(404).json({ success: false, message: "Doctor not found" });

        const today = new Date().toISOString().slice(0, 10);
        
        let appointmentsQuery = "SELECT * FROM appointments WHERE doctor_id = $1 AND date = $2 ORDER BY queue_number ASC";
        let queryParams = [userId, today];
        
        if (clinicId && clinicId !== 'null' && clinicId !== 'undefined') {
            appointmentsQuery = "SELECT * FROM appointments WHERE doctor_id = $1 AND date = $2 AND clinic_id = $3 ORDER BY queue_number ASC";
            queryParams.push(clinicId);
        }
        
        const appointmentsResult = await db.query(appointmentsQuery, queryParams);
        const schedulesResult = await db.query(`SELECT ds.*, c.name as clinic_name, c.address FROM doctor_schedules ds JOIN clinics c ON ds.clinic_id = c.id WHERE ds.doctor_id = $1`, [userId]);
        const clinicsResult = await db.query("SELECT * FROM clinics");
        const doctorRequestsResult = await db.query("SELECT * FROM clinic_join_requests WHERE doctor_id = $1", [userId]);
        const invitationsResult = await db.query(`SELECT ri.*, c.name as clinic_name FROM receptionist_invitations ri JOIN clinics c ON ri.clinic_id = c.id WHERE ri.doctor_id = $1`, [userId]);

        res.json({
            success: true,
            doctor: doctorResult.rows[0],
            appointments: appointmentsResult.rows,
            schedules: schedulesResult.rows,
            clinics: clinicsResult.rows,
            doctorRequests: doctorRequestsResult.rows,
            invitations: invitationsResult.rows
        });

    } catch (err) {
        console.error("Doctor dashboard error:", err);
        res.status(500).json({ success: false, message: "Error loading doctor dashboard" });
    }
});

app.get("/api/dashboard/receptionist/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const receptionistResult = await db.query("SELECT * FROM receptionists WHERE id = $1", [userId]);
        if (receptionistResult.rows.length === 0) return res.status(404).json({ success: false, message: "Receptionist not found" });
        const receptionist = receptionistResult.rows[0];

        const clinicResult = await db.query("SELECT * FROM clinics WHERE id = $1", [receptionist.clinic_id]);
        const clinic = clinicResult.rows[0];

        const appointmentsResult = await db.query("SELECT * FROM appointments WHERE clinic_id = $1", [clinic.id]);
        const clinicDoctorsResult = await db.query(`SELECT d.*, ds.start_time, ds.end_time, ds.days FROM doctors d JOIN doctor_schedules ds ON d.id = ds.doctor_id WHERE ds.clinic_id = $1`, [clinic.id]);
        const allDoctorsResult = await db.query("SELECT * FROM doctors ORDER BY name");
        const requestsResult = await db.query("SELECT * FROM clinic_join_requests WHERE clinic_id = $1 AND status = 'pending'", [clinic.id]);
        const invitationsResult = await db.query("SELECT * FROM receptionist_invitations WHERE receptionist_id = $1", [userId]);
        
        res.json({
            success: true,
            receptionist,
            clinic,
            appointments: appointmentsResult.rows,
            doctors: clinicDoctorsResult.rows,
            allDoctors: allDoctorsResult.rows,
            joinRequests: requestsResult.rows,
            invitations: invitationsResult.rows
        });
    } catch (err) {
        console.error("Receptionist dashboard error:", err);
        res.status(500).json({ success: false, message: "Error loading receptionist dashboard." });
    }
});

app.get("/api/dashboard/admin/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const [adminRes, patientsRes, doctorsRes, clinicsRes, appointmentsRes, receptionistsRes] = await Promise.all([
            db.query("SELECT * FROM admins WHERE id = $1", [userId]),
            db.query("SELECT * FROM patients ORDER BY name"),
            db.query("SELECT * FROM doctors ORDER BY name"),
            db.query("SELECT * FROM clinics ORDER BY name"),
            db.query("SELECT * FROM appointments ORDER BY date DESC, time DESC"),
            db.query("SELECT * FROM receptionists ORDER BY name")
        ]);

        if (adminRes.rows.length === 0) return res.status(404).json({ success: false, message: "Admin not found" });
        
        res.json({
            success: true,
            admin: adminRes.rows[0],
            patients: patientsRes.rows,
            doctors: doctorsRes.rows,
            clinics: clinicsRes.rows,
            appointments: appointmentsRes.rows,
            receptionists: receptionistsRes.rows
        });
    } catch (err) {
        console.error("Admin dashboard error:", err);
        res.status(500).json({ success: false, message: "Error loading admin dashboard." });
    }
});

// --- General API Routes ---
app.get("/api/doctors", async (req, res) => {
    const { name, specialty, clinic: clinicQuery } = req.query;
    try {
        let query = `SELECT DISTINCT d.id, d.name, d.specialty, d.phone FROM doctors d JOIN doctor_schedules ds ON d.id = ds.doctor_id JOIN clinics c ON ds.clinic_id = c.id WHERE 1=1`;
        let params = [];
        let paramIndex = 1;
        if (name) { query += ` AND d.name ILIKE $${paramIndex++}`; params.push(`%${name}%`); }
        if (specialty) { query += ` AND d.specialty ILIKE $${paramIndex++}`; params.push(`%${specialty}%`); }
        if (clinicQuery) { query += ` AND (c.name ILIKE $${paramIndex} OR c.address ILIKE $${paramIndex++})`; params.push(`%${clinicQuery}%`); }
        
        const doctorsResult = await db.query(query, params);
        res.json({ success: true, doctors: doctorsResult.rows });
    } catch (err) {
        console.error("API /api/doctors error:", err);
        res.status(500).json({ success: false, message: "Error fetching doctors." });
    }
});

app.get("/api/queue-status/:doctorId/:clinicId", (req, res) => {
    const { doctorId, clinicId } = req.params;
    const today = new Date().toISOString().slice(0, 10);
    const queueKey = `${doctorId}_${clinicId}`;
    
    db.query(`SELECT MAX(queue_number) as current_number, (SELECT COUNT(*) FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 AND date = $3) as total_patients FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 AND date = $3 AND status = 'Done'`, [doctorId, clinicId, today])
        .then(result => {
            const currentNumber = result.rows[0].current_number || 0;
            const totalPatients = result.rows[0].total_patients || 0;
            doctorQueueStatus[queueKey] = { date: today, currentNumber: parseInt(currentNumber), totalPatients: parseInt(totalPatients) };
            res.json(doctorQueueStatus[queueKey]);
        }).catch(err => {
            console.error("API /api/queue-status error:", err);
            res.status(500).json({ error: "Failed to get queue status" });
        });
});

// --- ACTION ROUTES (POST, PUT, DELETE) ---

app.post("/api/book-appointment", async (req, res) => {
    const { patientId, doctorId, clinicId, date } = req.body;
    try {
        const [doctorRes, patientRes, clinicRes, scheduleRes] = await Promise.all([
            db.query("SELECT * FROM doctors WHERE id = $1", [doctorId]),
            db.query("SELECT * FROM patients WHERE id = $1", [patientId]),
            db.query("SELECT * FROM clinics WHERE id = $1", [clinicId]),
            db.query("SELECT * FROM doctor_schedules WHERE doctor_id = $1 AND clinic_id = $2", [doctorId, clinicId])
        ]);

        const doctor = doctorRes.rows[0];
        const patient = patientRes.rows[0];
        const clinic = clinicRes.rows[0];
        const schedule = scheduleRes.rows[0];

        const queueNumber = await getNextQueueNumber(doctorId, date, clinicId);
        
        let approxTime = schedule.start_time;
        if (doctor.consultation_duration) {
            const start = new Date(`${date}T${schedule.start_time}`);
            start.setMinutes(start.getMinutes() + (queueNumber - 1) * doctor.consultation_duration);
            approxTime = start.toTimeString().slice(0, 5);
        }

        const newAppointment = await db.query(
            `INSERT INTO appointments (patient_id, patient_name, doctor_id, doctor_name, clinic_id, clinic_name, date, "time", status, queue_number) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Confirmed', $9) RETURNING *`,
            [patient.id, patient.name, doctor.id, doctor.name, clinic.id, clinic.name, date, approxTime, queueNumber]
        );

        res.json({ success: true, appointment: newAppointment.rows[0] });
    } catch (err) {
        console.error("Booking error:", err);
        res.status(500).json({ success: false, message: "Error booking appointment." });
    }
});

app.post("/api/doctor/next-patient", async (req, res) => {
    const { doctorId, clinicId } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    try {
        const result = await db.query(`SELECT * FROM appointments WHERE doctor_id = $1 AND date = $2 AND clinic_id = $3 AND status NOT IN ('Done', 'Absent') ORDER BY queue_number ASC LIMIT 1`, [doctorId, today, clinicId]);
        if (result.rows.length > 0) {
            const nextPatient = result.rows[0];
            await db.query("UPDATE appointments SET status = 'Done' WHERE id = $1", [nextPatient.id]);
             res.json({ success: true, message: `Patient #${nextPatient.queue_number} marked as done.` });
        } else {
             res.json({ success: false, message: "No more patients in the queue." });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Error processing next patient." });
    }
});


// All other action routes from your original file would be converted here...
// e.g., app.post("/api/receptionist/invite-doctor", ...), app.post("/api/admin/add-clinic", ...) etc.
// They will all take JSON, perform a DB operation, and return a JSON success/error response.

app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
});

