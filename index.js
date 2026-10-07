require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configuración de PostgreSQL
let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  // Inicializar tablas al arrancar
  const initDb = async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS guests (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          phone VARCHAR(50),
          attending BOOLEAN DEFAULT TRUE,
          adults INTEGER DEFAULT 1,
          children INTEGER DEFAULT 0,
          has_pets BOOLEAN DEFAULT FALSE,
          pet_details TEXT,
          allergies TEXT,
          notes TEXT,
          invitation_code VARCHAR(64) UNIQUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS photos (
          id SERIAL PRIMARY KEY,
          guest_name VARCHAR(255),
          image_url TEXT NOT NULL,
          caption TEXT,
          is_approved BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✅ Base de datos inicializada correctamente (tablas guests y photos listas).');
    } catch (err) {
      console.error('❌ Error al inicializar la base de datos:', err.message);
    }
  };

  initDb();
} else {
  console.warn('⚠️ No se ha detectado DATABASE_URL en las variables de entorno. El servidor arranca en modo demostración.');
}

// Ruta de estado de salud (Health Check)
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbStatus = 'connected';
    } catch (e) {
      dbStatus = 'error: ' + e.message;
    }
  }
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    database: dbStatus
  });
});

// Obtener lista y estadísticas de invitados (para panel de novios)
app.get('/api/guests', async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: 'Base de datos no configurada aún' });
  }

  try {
    const { rows: guests } = await pool.query('SELECT * FROM guests ORDER BY created_at DESC');

    // Estadísticas
    const stats = guests.reduce(
      (acc, g) => {
        if (g.attending) {
          acc.confirmedCount += 1;
          acc.totalAdults += g.adults || 0;
          acc.totalChildren += g.children || 0;
          if (g.has_pets) acc.totalPets += 1;
          if (g.allergies && g.allergies.trim()) acc.withAllergiesCount += 1;
        } else {
          acc.declinedCount += 1;
        }
        return acc;
      },
      { confirmedCount: 0, declinedCount: 0, totalAdults: 0, totalChildren: 0, totalPets: 0, withAllergiesCount: 0 }
    );

    res.json({ stats, guests });
  } catch (err) {
    console.error('Error al listar invitados:', err);
    res.status(500).json({ error: 'Error al consultar invitados' });
  }
});

// Guardar o actualizar confirmación (RSVP)
app.post('/api/rsvp', async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: 'Base de datos no disponible' });
  }

  const {
    name,
    phone,
    attending = true,
    adults = 1,
    children = 0,
    has_pets = false,
    pet_details = '',
    allergies = '',
    notes = '',
    invitation_code = null
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'El nombre es obligatorio' });
  }

  try {
    const query = `
      INSERT INTO guests (name, phone, attending, adults, children, has_pets, pet_details, allergies, notes, invitation_code, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
      RETURNING *;
    `;
    const values = [
      name.trim(),
      phone ? phone.trim() : null,
      Boolean(attending),
      parseInt(adults, 10) || 0,
      parseInt(children, 10) || 0,
      Boolean(has_pets),
      pet_details ? pet_details.trim() : null,
      allergies ? allergies.trim() : null,
      notes ? notes.trim() : null,
      invitation_code || null
    ];

    const result = await pool.query(query, values);
    res.status(201).json({ success: true, guest: result.rows[0] });
  } catch (err) {
    console.error('Error al guardar confirmación:', err);
    res.status(500).json({ error: 'Error al registrar la confirmación' });
  }
});

// Generador de mensaje de WhatsApp
app.get('/api/whatsapp-invite', (req, res) => {
  const { name = 'Familia / Amigo', phone = '', code = '' } = req.query;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const inviteLink = code ? `${baseUrl}?invitacion=${encodeURIComponent(code)}` : baseUrl;

  const message = `¡Hola ${name}! 💍✨ Nos hace muchísima ilusión invitarte a nuestra boda. Puedes ver todos los detalles y confirmar tu asistencia en el siguiente enlace: ${inviteLink}`;
  const cleanPhone = phone.replace(/[^0-9]/g, '');

  const whatsappUrl = cleanPhone
    ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;

  res.json({ message, inviteLink, whatsappUrl });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor de la boda en marcha en el puerto ${PORT}`);
  console.log(`🌐 Acceso local: http://localhost:${PORT}`);
});
