require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));
app.use('/images', express.static(path.join(__dirname, 'images')));

// Configuración de almacenamiento para fotos subidas por invitados
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'images', 'invitados');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const cleanBase = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
    const uniqueName = `foto_${Date.now()}_${cleanBase}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB máx
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen (JPG, PNG, WEBP, etc.)'));
    }
  }
});

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
          attending BOOLEAN DEFAULT NULL,
          adults INTEGER DEFAULT 1,
          children INTEGER DEFAULT 0,
          has_pets BOOLEAN DEFAULT FALSE,
          pet_details TEXT,
          allergies TEXT,
          notes TEXT,
          invitation_code VARCHAR(64) UNIQUE,
          whatsapp_sent BOOLEAN DEFAULT FALSE,
          status VARCHAR(50) DEFAULT 'pending',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        ALTER TABLE guests ADD COLUMN IF NOT EXISTS whatsapp_sent BOOLEAN DEFAULT FALSE;
        ALTER TABLE guests ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';

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

      // Sincronizar automáticamente la lista oficial de invitados si existe
      await syncGuestsFromDoc();
    } catch (err) {
      console.error('❌ Error al inicializar la base de datos:', err.message);
    }
  };

  initDb();
} else {
  console.warn('⚠️ No se ha detectado DATABASE_URL en las variables de entorno. El servidor arranca en modo demostración.');
}

// Función auxiliar para sincronizar la lista de invitados desde el archivo de texto
const syncGuestsFromDoc = async () => {
  if (!pool) return;
  try {
    const possiblePaths = [
      path.join(__dirname, 'doc', 'listado_invitados.txt'),
      path.join(__dirname, 'doc', 'lista_invitados.txt')
    ];
    const filePath = possiblePaths.find(p => fs.existsSync(p));

    if (!filePath) {
      console.log('ℹ️ No se encontró archivo de listado de invitados para sincronizar.');
      return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    let inserted = 0;
    for (const name of lines) {
      const existing = await pool.query('SELECT id FROM guests WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1', [name]);
      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO guests (name, status, attending, whatsapp_sent)
           VALUES ($1, 'pending', NULL, FALSE)`,
          [name]
        );
        inserted++;
      }
    }
    console.log(`✅ Sincronización de invitados completada (${lines.length} leídos, ${inserted} nuevos insertados desde ${path.basename(filePath)}).`);
  } catch (err) {
    console.error('⚠️ Error al sincronizar listado de invitados desde doc:', err.message);
  }
};

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
    const { rows: guests } = await pool.query('SELECT * FROM guests ORDER BY name ASC');

    const stats = guests.reduce(
      (acc, g) => {
        acc.totalGuests += 1;
        if (g.phone && g.phone.trim()) acc.withPhoneCount += 1;
        if (g.whatsapp_sent) acc.whatsappSentCount += 1;

        if (g.attending === true || g.status === 'confirmed') {
          acc.confirmedCount += 1;
          acc.totalAdults += g.adults || 0;
          acc.totalChildren += g.children || 0;
          if (g.has_pets) acc.totalPets += 1;
          if (g.allergies && g.allergies.trim()) acc.withAllergiesCount += 1;
        } else if (g.attending === false || g.status === 'declined') {
          acc.declinedCount += 1;
        } else {
          acc.pendingCount += 1;
        }
        return acc;
      },
      {
        totalGuests: 0,
        withPhoneCount: 0,
        whatsappSentCount: 0,
        confirmedCount: 0,
        declinedCount: 0,
        pendingCount: 0,
        totalAdults: 0,
        totalChildren: 0,
        totalPets: 0,
        withAllergiesCount: 0
      }
    );

    res.json({ stats, guests });
  } catch (err) {
    console.error('Error al listar invitados:', err);
    res.status(500).json({ error: 'Error al consultar invitados' });
  }
});

// Obtener nombres para autocompletado en el formulario público
app.get('/api/guests/names', async (req, res) => {
  if (!pool) return res.json({ names: [] });
  try {
    const { rows } = await pool.query('SELECT id, name, phone FROM guests ORDER BY name ASC');
    res.json({ names: rows });
  } catch (err) {
    res.json({ names: [] });
  }
});

// Sincronizar invitados manualmente desde archivo doc
app.post('/api/guests/sync', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    await syncGuestsFromDoc();
    const { rows: guests } = await pool.query('SELECT * FROM guests ORDER BY name ASC');
    res.json({ success: true, message: 'Invitados sincronizados correctamente', count: guests.length });
  } catch (err) {
    res.status(500).json({ error: 'Error al sincronizar: ' + err.message });
  }
});

// Añadir un nuevo invitado manualmente desde el panel
app.post('/api/guests', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Base de datos no disponible' });
  const { name, phone = null, notes = null } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'El nombre es obligatorio' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO guests (name, phone, status, attending, whatsapp_sent, notes)
       VALUES ($1, $2, 'pending', NULL, FALSE, $3)
       RETURNING *`,
      [name.trim(), phone ? phone.trim() : null, notes ? notes.trim() : null]
    );
    res.status(201).json({ success: true, guest: result.rows[0] });
  } catch (err) {
    console.error('Error al añadir invitado:', err);
    res.status(500).json({ error: 'Error al añadir invitado' });
  }
});

// Actualizar datos de un invitado (teléfono, envío de WhatsApp, estado RSVP, etc.)
app.put('/api/guests/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Base de datos no disponible' });
  const { id } = req.params;
  const { phone, whatsapp_sent, status, attending, notes, adults, children, has_pets, allergies } = req.body;

  try {
    const fields = [];
    const values = [];
    let idx = 1;

    if (phone !== undefined) {
      fields.push(`phone = $${idx++}`);
      values.push(phone ? phone.trim() : null);
    }
    if (whatsapp_sent !== undefined) {
      fields.push(`whatsapp_sent = $${idx++}`);
      values.push(Boolean(whatsapp_sent));
    }
    if (status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(status);
    }
    if (attending !== undefined) {
      fields.push(`attending = $${idx++}`);
      values.push(attending === null ? null : Boolean(attending));
    }
    if (notes !== undefined) {
      fields.push(`notes = $${idx++}`);
      values.push(notes ? notes.trim() : null);
    }
    if (adults !== undefined) {
      fields.push(`adults = $${idx++}`);
      values.push(parseInt(adults, 10) || 0);
    }
    if (children !== undefined) {
      fields.push(`children = $${idx++}`);
      values.push(parseInt(children, 10) || 0);
    }
    if (has_pets !== undefined) {
      fields.push(`has_pets = $${idx++}`);
      values.push(Boolean(has_pets));
    }
    if (allergies !== undefined) {
      fields.push(`allergies = $${idx++}`);
      values.push(allergies ? allergies.trim() : null);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No se enviaron campos para actualizar' });
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const query = `UPDATE guests SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`;
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invitado no encontrado' });
    }

    res.json({ success: true, guest: result.rows[0] });
  } catch (err) {
    console.error('Error al actualizar invitado:', err);
    res.status(500).json({ error: 'Error al actualizar invitado' });
  }
});

// Eliminar invitado
app.delete('/api/guests/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Base de datos no disponible' });
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM guests WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invitado no encontrado' });
    }
    res.json({ success: true, message: 'Invitado eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar invitado' });
  }
});

// Guardar o actualizar confirmación (RSVP)
app.post('/api/rsvp', async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: 'Base de datos no disponible' });
  }

  const {
    guest_id = null,
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

  const cleanName = name.trim();
  const isAttending = Boolean(attending);
  const guestStatus = isAttending ? 'confirmed' : 'declined';

  try {
    // Buscar si el invitado ya existe por id o por nombre (case-insensitive)
    let existing = { rows: [] };
    if (guest_id) {
      existing = await pool.query('SELECT id, phone FROM guests WHERE id = $1 LIMIT 1', [guest_id]);
    }
    if (existing.rows.length === 0) {
      existing = await pool.query(
        'SELECT id, phone FROM guests WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1',
        [cleanName]
      );
    }

    let savedGuest;
    if (existing.rows.length > 0) {
      const guestId = existing.rows[0].id;
      const finalPhone = phone && phone.trim() ? phone.trim() : existing.rows[0].phone;
      const updateQuery = `
        UPDATE guests
        SET phone = $1, attending = $2, status = $3, adults = $4, children = $5,
            has_pets = $6, pet_details = $7, allergies = $8, notes = $9,
            invitation_code = COALESCE($10, invitation_code), updated_at = CURRENT_TIMESTAMP
        WHERE id = $11
        RETURNING *;
      `;
      const updateValues = [
        finalPhone,
        isAttending,
        guestStatus,
        parseInt(adults, 10) || 0,
        parseInt(children, 10) || 0,
        Boolean(has_pets),
        pet_details ? pet_details.trim() : null,
        allergies ? allergies.trim() : null,
        notes ? notes.trim() : null,
        invitation_code || null,
        guestId
      ];
      const result = await pool.query(updateQuery, updateValues);
      savedGuest = result.rows[0];
    } else {
      const insertQuery = `
        INSERT INTO guests (name, phone, attending, status, adults, children, has_pets, pet_details, allergies, notes, invitation_code, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
        RETURNING *;
      `;
      const insertValues = [
        cleanName,
        phone ? phone.trim() : null,
        isAttending,
        guestStatus,
        parseInt(adults, 10) || 0,
        parseInt(children, 10) || 0,
        Boolean(has_pets),
        pet_details ? pet_details.trim() : null,
        allergies ? allergies.trim() : null,
        notes ? notes.trim() : null,
        invitation_code || null
      ];
      const result = await pool.query(insertQuery, insertValues);
      savedGuest = result.rows[0];
    }

    res.status(201).json({ success: true, guest: savedGuest });
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

  const message = `¡Hola ${name}! Blanca y Álvaro nos casamos el 29 de Mayo de 2027 en Restaurante Magullo (Segovia). Puedes ver todos los detalles y confirmar tu asistencia en el siguiente enlace: ${inviteLink}`;
  const cleanPhone = phone.replace(/[^0-9]/g, '');

  const whatsappUrl = cleanPhone
    ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;

  res.json({ message, inviteLink, whatsappUrl });
});

// Endpoint para consultar fotos de la galería (restaurante, novios e invitados)
app.get('/api/gallery', async (req, res) => {
  try {
    const venueDir = path.join(__dirname, 'images', 'restaurante');
    const noviosDir = path.join(__dirname, 'images', 'novios');
    const imageRegex = /\.(webp|jpg|jpeg|png|gif)$/i;

    const venue = fs.existsSync(venueDir)
      ? fs.readdirSync(venueDir).filter(f => imageRegex.test(f)).map(f => `/images/restaurante/${f}`)
      : [];

    const novios = fs.existsSync(noviosDir)
      ? fs.readdirSync(noviosDir).filter(f => imageRegex.test(f)).map(f => `/images/novios/${f}`)
      : [];

    let invitados = [];
    if (pool) {
      const { rows } = await pool.query('SELECT * FROM photos ORDER BY created_at DESC');
      invitados = rows;
    } else {
      const invitadosDir = path.join(__dirname, 'images', 'invitados');
      if (fs.existsSync(invitadosDir)) {
        invitados = fs.readdirSync(invitadosDir)
          .filter(f => imageRegex.test(f))
          .map(f => ({
            id: f,
            image_url: `/images/invitados/${f}`,
            guest_name: 'Invitado',
            caption: '',
            is_approved: true
          }));
      }
    }

    res.json({ venue, novios, invitados });
  } catch (err) {
    console.error('Error leyendo galería:', err);
    res.status(500).json({ error: 'Error al consultar imágenes' });
  }
});

// Endpoint para que los invitados suban fotos desde la web
app.post('/api/photos/upload', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Debes seleccionar una imagen para subir' });
  }

  const guestName = req.body.guest_name ? req.body.guest_name.trim() : 'Invitado anónimo';
  const caption = req.body.caption ? req.body.caption.trim() : '';
  const imageUrl = `/images/invitados/${req.file.filename}`;

  try {
    let photoRecord = {
      id: Date.now(),
      guest_name: guestName,
      image_url: imageUrl,
      caption,
      is_approved: true,
      created_at: new Date()
    };

    if (pool) {
      const result = await pool.query(
        'INSERT INTO photos (guest_name, image_url, caption, is_approved) VALUES ($1, $2, $3, $4) RETURNING *',
        [guestName, imageUrl, caption, true]
      );
      photoRecord = result.rows[0];
    }

    res.status(201).json({ success: true, photo: photoRecord });
  } catch (err) {
    console.error('Error al guardar foto en BD:', err);
    res.status(500).json({ error: 'Error al registrar la foto' });
  }
});

// Endpoint para que los novios aprueben / seleccionen fotos destacadas
app.patch('/api/photos/:id/toggle-approve', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Base de datos no disponible' });
  const { id } = req.params;
  try {
    const result = await pool.query(
      'UPDATE photos SET is_approved = NOT is_approved WHERE id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Foto no encontrada' });
    res.json({ success: true, photo: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor de la boda en marcha en el puerto ${PORT}`);
  console.log(`🌐 Acceso local: http://localhost:${PORT}`);
});
