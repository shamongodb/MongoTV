const express = require('express');

const router = express.Router();

router.get('/how-it-works', (req, res) => {
  res.render('how-it-works', {
    title: 'How It Works',
    activePage: 'how-it-works',
  });
});

module.exports = router;
