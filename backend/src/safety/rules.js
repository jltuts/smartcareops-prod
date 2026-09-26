// The existing M2/M3 supported red flags, now with stable workflow metadata.
// No numeric thresholds, new medical criteria, or inferred symptom combinations.
export const safetyRules = Object.freeze([
  { flag: 'current chest pain', reasonCode: 'chest_pain_red_flag', reasonSummary: 'Patient reported a confirmed current chest pain red flag.', trigger: 'redFlag:current_chest_pain' },
  { flag: 'severe difficulty breathing', reasonCode: 'severe_breathing_red_flag', reasonSummary: 'Patient reported a confirmed severe breathing difficulty red flag.', trigger: 'redFlag:severe_difficulty_breathing' },
  { flag: 'loss of consciousness', reasonCode: 'loss_of_consciousness_red_flag', reasonSummary: 'Patient reported a confirmed loss of consciousness red flag.', trigger: 'redFlag:loss_of_consciousness' },
  { flag: 'stroke-like symptoms', reasonCode: 'stroke_like_red_flag', reasonSummary: 'Patient reported a confirmed stroke-like symptoms red flag.', trigger: 'redFlag:stroke_like_symptoms' },
  { flag: 'severe uncontrolled bleeding', reasonCode: 'severe_bleeding_red_flag', reasonSummary: 'Patient reported a confirmed severe uncontrolled bleeding red flag.', trigger: 'redFlag:severe_uncontrolled_bleeding' },
].map(rule => Object.freeze(rule)));
