// Evidence-bound safety triggers with stable workflow metadata. No numeric
// thresholds or inferred symptom combinations are used.
export const safetyRules = Object.freeze([
  { flag: 'current chest pain', reasonCode: 'chest_pain_red_flag', reasonSummary: 'Patient reported a confirmed current chest pain red flag.', trigger: 'redFlag:current_chest_pain' },
  { flag: 'severe difficulty breathing', reasonCode: 'severe_breathing_red_flag', reasonSummary: 'Patient reported a confirmed severe breathing difficulty red flag.', trigger: 'redFlag:severe_difficulty_breathing' },
  { flag: 'loss of consciousness', reasonCode: 'loss_of_consciousness_red_flag', reasonSummary: 'Patient reported a confirmed loss of consciousness red flag.', trigger: 'redFlag:loss_of_consciousness' },
  { flag: 'stroke-like symptoms', reasonCode: 'stroke_like_red_flag', reasonSummary: 'Patient reported a confirmed stroke-like symptoms red flag.', trigger: 'redFlag:stroke_like_symptoms' },
  { flag: 'severe uncontrolled bleeding', reasonCode: 'severe_bleeding_red_flag', reasonSummary: 'Patient reported a confirmed severe uncontrolled bleeding red flag.', trigger: 'redFlag:severe_uncontrolled_bleeding' },
  { flag: 'patient requested emergency assistance', reasonCode: 'patient_emergency_request', reasonSummary: 'Patient explicitly requested emergency assistance.', trigger: 'redFlag:patient_requested_emergency_assistance' },
].map(rule => Object.freeze(rule)));
