// Entire short conversational repairs only. Mixed clinical answers must still
// reach extraction and the unchanged Safety Engine.
export function isConfusion(text) {
  if (typeof text !== 'string' || text.length > 180) return false;
  const normalized = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’']/g, '').replace(/[¿¡?!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const phrase = /^(?:(?:que es eso|como|no entiendo|no comprendo|what do you mean|what does that mean|i (?:dont|do not|didnt|did not) understand(?: the question| that)?|(?:can|could) you explain(?: that)?(?: please)?|can you repeat that|could you repeat that|please repeat that|say that again|please say that again|i dont get it|i do not get it|pardon me|sorry|pardon|what|huh|que)(?:\s+|$))+/;
  return normalized.replace(phrase, '').trim() === '';
}
export function clarificationFor(question) {
  if (/(?:describe|feel like|sharp|dull|throbbing|quality)/i.test(question) && /(?:pain|headache)/i.test(question)) return 'Sorry, I may not have explained that clearly. What does the pain feel like — for example, pressure, pounding, sharp, or aching?';
  if (/\bname\b/i.test(question)) return 'What name would you like me to use?';
  const current = question.trim().split(/(?<=[.!])\s+/).at(-1);
  return current?.includes('?') ? `Sorry, I may not have explained that clearly. ${current}` : 'Sorry, I may not have explained that clearly. Could you tell me which part you would like explained?';
}
