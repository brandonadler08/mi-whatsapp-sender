const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h1>✅ CONEXIÓN EXITOSA</h1><p>Si ves esto, tu Windows y Firewall permiten conexiones en este puerto. El problema está en la App de WhatsApp y lo arreglaremos ahora mismo.</p>');
});

const PORT = 3005;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n==========================================`);
  console.log(`      PRUEBA DE CONEXIÓN ACTIVA`);
  console.log(`==========================================`);
  console.log(`\n1. Entra a: http://localhost:${PORT}`);
  console.log(`2. NO CIERRES esta ventana hasta probar.`);
  console.log(`\nSi no carga, revisa tu Antivirus o Firewall.`);
});
