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
    try {
        const userRes = await db.query(`SELECT * FROM ${role}s WHERE id = $1`, [userId]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: `${role} not found` });
        
        let data = { success: true, [role]: userRes.rows[0] };

        if (role === 'patient') {
            const appointmentsRes = await db.query("SELECT * FROM appointments WHERE patient_id = $1 ORDER BY date DESC, time ASC", [userId]);
            data.appointments = appointmentsRes.rows;
        } else if (role === 'doctor') {
            const today = new Date().toISOString().slice(0, 10);
            const [appointmentsRes, schedulesRes, clinicsRes, requestsRes, invitationsRes] = await Promise.all([
                db.query("SELECT * FROM appointments WHERE doctor_id = $1 AND date = $2 ORDER BY queue_number ASC", [userId, today]),
                db.query(`SELECT ds.*, c.name as clinic_name FROM doctor_schedules ds JOIN clinics c ON ds.clinic_id = c.id WHERE ds.doctor_id = $1`, [userId]),
                db.query("SELECT * FROM clinics ORDER BY name"),
                db.query("SELECT * FROM clinic_join_requests WHERE doctor_id = $1", [userId]),
                db.query(`SELECT ri.*, c.name as clinic_name FROM receptionist_invitations ri JOIN clinics c ON ri.clinic_id = c.id WHERE ri.doctor_id = $1`, [userId])
            ]);
            data = { ...data, appointments: appointmentsRes.rows, schedules: schedulesRes.rows, clinics: clinicsRes.rows, doctorRequests: requestsRes.rows, invitations: invitationsRes.rows };
        } else if (role === 'receptionist') {
            const user = userRes.rows[0];
            const [clinicRes, appointmentsRes, clinicDocsRes, allDocsRes, requestsRes, invitationsRes] = await Promise.all([
                 db.query("SELECT * FROM clinics WHERE id = $1", [user.clinic_id]),
                 db.query("SELECT * FROM appointments WHERE clinic_id = $1 ORDER BY date DESC, time ASC", [user.clinic_id]),
                 db.query(`SELECT d.*, ds.start_time, ds.end_time, ds.days FROM doctors d JOIN doctor_schedules ds ON d.id = ds.doctor_id WHERE ds.clinic_id = $1`, [user.clinic_id]),
                 db.query("SELECT * FROM doctors ORDER BY name"),
                 db.query("SELECT * FROM clinic_join_requests WHERE clinic_id = $1 AND status = 'pending'", [user.clinic_id]),
                 db.query("SELECT * FROM receptionist_invitations WHERE receptionist_id = $1", [userId])
            ]);
            data = { ...data, clinic: clinicRes.rows[0], appointments: appointmentsRes.rows, doctors: clinicDocsRes.rows, allDoctors: allDocsRes.rows, joinRequests: requestsRes.rows, invitations: invitationsRes.rows };
        } else if (role === 'admin') {
             const [patientsRes, doctorsRes, clinicsRes, appointmentsRes, receptionistsRes] = await Promise.all([
                db.query("SELECT * FROM patients ORDER BY name"),
                db.query("SELECT * FROM doctors ORDER BY name"),
                db.query("SELECT * FROM clinics ORDER BY name"),
                db.query("SELECT * FROM appointments ORDER BY date DESC"),
                db.query("SELECT * FROM receptionists ORDER BY name")
            ]);
            data = { ...data, patients: patientsRes.rows, doctors: doctorsRes.rows, clinics: clinicsRes.rows, appointments: appointmentsRes.rows, receptionists: receptionistsRes.rows };
        }
        res.json(data);
    } catch (err) {
        res.status(500).json({ success: false, message: `Error fetching ${role} data.` });
    }
});

// --- Search and General GET ---
app.get("/api/doctors", async (req, res) => {
    const { name, specialty, clinic } = req.query;
    try {
        let query = `SELECT DISTINCT d.id, d.name, d.specialty, d.phone FROM doctors d LEFT JOIN doctor_schedules ds ON d.id = ds.doctor_id LEFT JOIN clinics c ON ds.clinic_id = c.id WHERE 1=1`;
        let params = [];
        let i = 1;
        if (name) { query += ` AND d.name ILIKE $${i++}`; params.push(`%${name}%`); }
        if (specialty) { query += ` AND d.specialty ILIKE $${i++}`; params.push(`%${specialty}%`); }
        if (clinic) { query += ` AND c.name ILIKE $${i++}`; params.push(`%${clinic}%`); }
        query += " ORDER BY d.name";
        
        const doctorsResult = await db.query(query, params);
        for (let doctor of doctorsResult.rows) {
            const scheduleRes = await db.query(`SELECT ds.*, c.name as clinic_name FROM doctor_schedules ds JOIN clinics c ON ds.clinic_id = c.id WHERE ds.doctor_id = $1`, [doctor.id]);
            doctor.schedules = scheduleRes.rows;
        }
        res.json({ success: true, doctors: doctorsResult.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: "Error searching doctors." });
    }
});

// --- All Action Routes ---
app.post("/api/appointments/book", async (req, res) => {
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
        console.error("Booking error:", err);
        res.status(500).json({ success: false, message: "Error booking appointment." });
    }
});

// Add other routes here...

// --- Server ---
app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
});

