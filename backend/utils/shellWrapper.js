const { execFile } = require('child_process');
require('dotenv').config();

const WRAPPER = process.env.UDP_WRAPPER_PATH;

// Uses execFile (not exec) with an args array so user input is never
// interpolated into a shell string - this avoids command injection.
function runWrapper(action, args = []) {
  return new Promise((resolve, reject) => {
    execFile('bash', [WRAPPER, action, ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr || err.message));
      }
      resolve(stdout.trim());
    });
  });
}

module.exports = { runWrapper };
