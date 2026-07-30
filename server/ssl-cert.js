/**
 * ssl-cert.js
 * Generates a self-signed SSL certificate using node-forge.
 * Compatible with Node.js v20+.
 */

const forge = require('node-forge');

function generateSelfSignedCert(ip) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  const attrs = [
    { name: 'commonName', value: ip || 'localhost' },
    { name: 'organizationName', value: 'OPPO Photobooth' },
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  // Add Subject Alternative Names so browsers accept it
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, nonRepudiation: true, keyEncipherment: true, dataEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 7, ip: ip || '127.0.0.1' },
        { type: 7, ip: '127.0.0.1' },
        { type: 2, value: 'localhost' },
      ],
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

module.exports = { generateSelfSignedCert };
