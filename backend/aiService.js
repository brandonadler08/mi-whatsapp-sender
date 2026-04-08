const { OpenAI } = require('openai');

/**
 * aiService.js — Servicio para manejar respuestas automáticas usando OpenAI.
 */
class AIService {
  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY;
    this.openai = this.apiKey ? new OpenAI({ apiKey: this.apiKey }) : null;
  }

  async generateResponse(userMessage, systemPrompt) {
    if (!this.openai) {
      throw new Error('OPENAI_API_KEY no configurada en el servidor.');
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo", // O gpt-4o-mini para más velocidad/costo
        messages: [
          { role: "system", content: systemPrompt || "Eres un asistente amable de servicio al cliente." },
          { role: "user", content: userMessage }
        ],
        max_tokens: 200,
        temperature: 0.7,
      });

      return response.choices[0].message.content.trim();
    } catch (err) {
      console.error('AI Error:', err.message);
      throw new Error('No se pudo generar una respuesta de IA.');
    }
  }
}

module.exports = new AIService();
