const express = require('express');
const cors = require('cors');
const bibliaRoutes = require('./biblia'); // Import the new Bible routes
require('dotenv').config(); // Load environment variables from .env file

const app = express();

// Enable CORS for all origins
app.use(cors());
const port = 1020; // Use port from .env or default to 3000

// Middleware to parse JSON bodies
app.use(express.json());

// Use the Bible routes defined in routes/biblia.js
app.use('/api', bibliaRoutes); // Mount the Bible routes under /biblia path

// Basic route for root path
app.get('/', (req, res) => {
  res.send('API Webhook Agente is running!');
});

// Start the server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
