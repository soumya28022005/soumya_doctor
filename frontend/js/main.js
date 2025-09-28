// --- CONFIGURATION ---
// IMPORTANT: You MUST update this URL to your live Render backend URL after deploying
const API_URL = 'http://localhost:3000'; // For local testing
// const API_URL = 'https://your-backend-app-name.onrender.com'; // Example for Render

// --- Universal Page Load Logic ---
document.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname.split('/').pop();

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', logout);
    }

    // Simple router
    switch (path) {
        case 'login.html':
            handleLoginPage();
            break;
        case 'signup.html':
            handleSignupPage();
            break;
        case 'patient-dashboard.html':
            loadDashboard('patient');
            break;
        case 'doctor-dashboard.html':
            loadDashboard('doctor');
            break;
        case 'receptionist-dashboard.html':
            loadDashboard('receptionist');
            break;
        case 'admin-dashboard.html':
            loadDashboard('admin');
            break;
    }
});

// --- Auth Functions ---
function logout() {
    localStorage.clear();
    window.location.href = 'index.html';
}

function handleLoginPage() {
    if (localStorage.getItem('user')) { // Redirect if already logged in
        window.location.href = `${localStorage.getItem('role')}-dashboard.html`;
        return;
    }
    const urlParams = new URLSearchParams(window.location.search);
    const role = urlParams.get('role');
    if (!role) { window.location.href = 'index.html'; return; }
    
    document.getElementById('login-title').innerHTML = `Login as <span style="text-transform: capitalize;">${role}</span>`;
    if (role === 'patient') document.getElementById('signup-link-container').style.display = 'block';

    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const { username, password } = e.target.elements;
        const response = await apiRequest(`login/${role}`, 'POST', { username: username.value, password: password.value });
        if (response.success) {
            localStorage.setItem('user', JSON.stringify(response.user));
            localStorage.setItem('role', role);
            window.location.href = `${role}-dashboard.html`;
        } else {
            showError(response.message);
        }
    });
}

function handleSignupPage() {
    document.getElementById('signup-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const { name, dob, mobile, username, password } = e.target.elements;
        const response = await apiRequest('signup/patient', 'POST', { 
            name: name.value, dob: dob.value, mobile: mobile.value, 
            username: username.value, password: password.value 
        });
        if (response.success) {
            alert('Signup successful! Please login.');
            window.location.href = 'login.html?role=patient';
        } else {
            showError(response.message);
        }
    });
}

// --- Dashboard Loading ---
async function loadDashboard(role) {
    const user = JSON.parse(localStorage.getItem('user'));
    if (!user || localStorage.getItem('role') !== role) {
        window.location.href = `login.html?role=${role}`;
        return;
    }

    const container = document.getElementById('dashboard-container');
    const data = await apiRequest(`dashboard/${role}/${user.id}`);
    
    if (data.success) {
        // Render the specific dashboard based on role
        if (role === 'patient') renderPatientDashboard(container, data);
        if (role === 'doctor') renderDoctorDashboard(container, data);
        if (role === 'receptionist') renderReceptionistDashboard(container, data);
        if (role === 'admin') renderAdminDashboard(container, data);
    } else {
        container.innerHTML = `<h1>Error: ${data.message}</h1>`;
    }
}

// --- RENDER FUNCTIONS (These build the HTML for each dashboard) ---

function renderPatientDashboard(container, data) {
    container.innerHTML = `
        <div class="dashboard-header">
            <h1>Welcome, ${data.patient.name}</h1>
            <p>Here are your appointments.</p>
        </div>
        <div class="card">
            <h3>Your Appointments</h3>
            <ul class="appointment-list">
                ${data.appointments.map(app => `
                    <li class="appointment-item">
                        <strong>Dr. ${app.doctor_name}</strong> on ${new Date(app.date).toLocaleDateString()}<br>
                        <small>${app.clinic_name} at ${app.time} (Queue #${app.queue_number})</small>
                    </li>
                `).join('') || '<p>You have no appointments.</p>'}
            </ul>
        </div>
        <div class="card">
            <h3>Book a New Appointment</h3>
            <!-- Booking form would go here -->
        </div>
    `;
}

function renderDoctorDashboard(container, data) {
    container.innerHTML = `
        <div class="dashboard-header">
            <h1>Welcome, Dr. ${data.doctor.name}</h1>
            <p>Manage your appointments and queue.</p>
        </div>
        <div class="card">
            <h3>Today's Appointments</h3>
             <ul class="appointment-list">
                ${data.appointments.map(app => `
                    <li class="appointment-item">
                        <strong>${app.patient_name}</strong> (Queue #${app.queue_number})<br>
                        <small>Time: ${app.time} | Status: ${app.status}</small>
                    </li>
                `).join('') || '<p>No appointments for today.</p>'}
            </ul>
        </div>
         <div class="card">
            <h3>Invitations</h3>
             <ul class="appointment-list">
                ${data.invitations.map(inv => `
                    <li class="appointment-item">
                        <strong>${inv.clinic_name}</strong> has invited you to join.<br>
                        <small>Proposed Schedule: ${inv.start_time} - ${inv.end_time} on ${inv.days}</small>
                    </li>
                `).join('') || '<p>You have no pending invitations.</p>'}
            </ul>
        </div>
    `;
}
function renderReceptionistDashboard(container, data) {
    container.innerHTML = `
        <div class="dashboard-header">
            <h1>Welcome, ${data.receptionist.name}</h1>
            <p>Managing ${data.clinic.name}</p>
        </div>
        <div class="card">
            <h3>Doctors at this Clinic</h3>
             <ul class="appointment-list">
                ${data.doctors.map(doc => `
                    <li class="appointment-item">
                        <strong>Dr. ${doc.name}</strong> - ${doc.specialty}<br>
                        <small>Schedule: ${doc.start_time} - ${doc.end_time} on ${doc.days}</small>
                    </li>
                `).join('') || '<p>No doctors assigned to this clinic.</p>'}
            </ul>
        </div>
    `;
}

function renderAdminDashboard(container, data) {
    container.innerHTML = `
        <div class="dashboard-header">
            <h1>Admin Overview</h1>
            <p>Manage all system entities.</p>
        </div>
        <div class="dashboard-grid">
            <div class="card">
                <h3>Clinics (${data.clinics.length})</h3>
            </div>
            <div class="card">
                <h3>Doctors (${data.doctors.length})</h3>
            </div>
            <div class="card">
                <h3>Patients (${data.patients.length})</h3>
            </div>
             <div class="card">
                <h3>Receptionists (${data.receptionists.length})</h3>
            </div>
        </div>
    `;
}


// --- UTILITY FUNCTIONS ---
async function apiRequest(endpoint, method = 'GET', body = null) {
    try {
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (body) {
            options.body = JSON.stringify(body);
        }
        const response = await fetch(`${API_URL}/api/${endpoint}`, options);
        return await response.json();
    } catch (error) {
        console.error('API Request Error:', error);
        return { success: false, message: 'Could not connect to the server.' };
    }
}

function showError(message) {
    const errorMessage = document.getElementById('error-message');
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
}

