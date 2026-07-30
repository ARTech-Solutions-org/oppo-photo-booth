/**
 * ip-helper.js
 * Detects the local network IP address of the machine.
 * Prefers 10.x.x.x, then 192.168.x.x, then 172.x.x.x over link-local (169.254.x.x).
 */

const os = require('os');

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  let fallback = null;

  // Priority order: 10.x > 192.168.x > 172.x > anything else (non-internal, non-link-local)
  const priorities = [
    (ip) => ip.startsWith('10.'),
    (ip) => ip.startsWith('192.168.'),
    (ip) => ip.startsWith('172.'),
  ];

  for (const check of priorities) {
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal && check(iface.address)) {
          return iface.address;
        }
      }
    }
  }

  // Last resort: any non-internal, non-link-local IPv4
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        if (!fallback) fallback = iface.address;
      }
    }
  }

  return fallback || '127.0.0.1';
}

module.exports = { getLocalIP };
