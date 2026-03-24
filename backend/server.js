const express = require('express');
const cors = require('cors');
const path = require('path');
const { getDb } = require('./database');

async function start() {
  await getDb();
  const app = express();
  const PORT = process.env.PORT || 3456;
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '..', 'frontend')));
  app.use('/api', require('./routes'));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
  });
  app.listen(PORT, '0.0.0.0', () => console.log(`Tenant Invoice Manager running on port ${PORT}`));
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
