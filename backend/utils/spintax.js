/**
 * spintax.js — Utilería para procesar variaciones de texto.
 * Ejemplo: "{Hola|Buen día|Hey}" devuelve uno de los tres al azar.
 */

function applySpintax(text) {
  if (!text) return '';
  
  const spintaxRegex = /\{([^{}]+)\}/g;
  
  let matches;
  while ((matches = spintaxRegex.exec(text)) !== null) {
    const options = matches[1].split('|');
    const choice = options[Math.floor(Math.random() * options.length)];
    text = text.replace(matches[0], choice);
    
    // Reiniciar regex para manejar anidamientos si los hubiera
    spintaxRegex.lastIndex = 0;
  }
  
  return text;
}

module.exports = { applySpintax };
