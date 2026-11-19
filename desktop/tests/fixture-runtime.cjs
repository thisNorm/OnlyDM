'use strict';

const { app } = require('electron');

// Hosted virtual displays may not provide a usable GPU. Keep this out of the app.
if (process.env.ONLYDM_FIXTURE_SOFTWARE_RENDERING === '1') app.disableHardwareAcceleration();
