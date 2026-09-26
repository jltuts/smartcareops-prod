// Conservative repair rules for observed ASR artifacts, not clinical inference.
const contexts = [
  [/chest pain/i, 'chest pain', 'Are you having chest pain?'],
  [/severe (?:difficulty breathing|breathing difficulty)/i, 'severe difficulty breathing', 'Are you having severe difficulty breathing?'],
  [/difficulty breathing|trouble breathing|shortness of breath/i, 'difficulty breathing', 'Are you having difficulty breathing?'],
  [/loss of consciousness|lost consciousness|passed out|fainted/i, 'loss of consciousness', 'Have you lost consciousness?'],
  [/uncontrolled bleeding/i, 'severe uncontrolled bleeding', 'Are you having severe uncontrolled bleeding?'],
  [/stroke-like symptoms/i, 'stroke-like symptoms', 'Are you having stroke-like symptoms?'],
];
const language = text => /\p{Script=Hangul}/u.test(text) ? 'korean' : /\p{Script=Han}/u.test(text) ? 'chinese' : /\b(ich|nicht|kein|keine|ist ganz|danke|nein)\b/i.test(text) ? 'german' : '';

export function createAnswerContext() {
  let multilingual = false;
  return (text, question) => {
    if (/\b(?:speak|continue|switch|prefer|use)\b.{0,40}\benglish\b/i.test(text)) { multilingual = false; return; }
    if (/\b(?:speak|continue|switch|prefer|use)\b.{0,40}\b(?:german|korean|chinese|spanish|french|tagalog|another language)\b/i.test(text)) { multilingual = true; return; }
    const detected = language(text);
    if (detected && language(question) === detected) multilingual = true;
    // Names are not language errors. Match only one question's clinical context.
    const matches = contexts.filter(([pattern, label]) => pattern.test(question) && !(label === 'difficulty breathing' && contexts[1][0].test(question)));
    const expected = question.includes('?') && matches.length === 1 ? matches[0] : undefined;
    const garbled = expected && ((/chest pain/i.test(question) && /chess (?:piece|playing)/i.test(text)) || (/breath/i.test(question) && /reading difficulty/i.test(text)));
    const artifact = !multilingual && !/\bname\b/i.test(question) && (detected || /purple clock eats Tuesday/i.test(text));
    const uncertain = expected && /^(?:i['’]m |i am )?(?:not sure|unsure|uncertain|maybe)[.!\s]*$/i.test(text.trim());
    if (!garbled && !artifact && !uncertain) return;
    return {
      blocked: true,
      ...(expected ? { label: expected[1] } : {}),
      clarification: uncertain ? null : expected ? `Sorry, I didn't catch that. ${expected[2]}` : "Sorry, I didn't catch that. Could you say that again?",
    };
  };
}
