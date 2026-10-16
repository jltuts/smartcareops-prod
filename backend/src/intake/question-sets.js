export const answerStates = Object.freeze([
  'answered', 'denied', 'unclear', 'does_not_know', 'skipped', 'needs_clarification', 'not_applicable',
]);

const q = (id, paths, phase, prompt, requiredFacts, options = {}) => Object.freeze({
  id, paths: Object.freeze(paths), phase, prompt, requiredFacts: Object.freeze(requiredFacts),
  eligibility: Object.freeze(options.eligibility || { all: [] }),
  completion: Object.freeze({ required: options.required !== false, skippable: options.skippable !== false }),
  safetyPriority: options.safetyPriority || 0,
  supportedAnswerStates: Object.freeze(options.states || answerStates),
  answerType: options.answerType || 'narrative', order: options.order || 0,
});

export const complaintPaths = Object.freeze(['general', 'musculoskeletal_shoulder', 'skin', 'chest', 'breathing']);

export const questionSets = Object.freeze([
  q('core.name', complaintPaths, 'main_concern', 'What name would you like me to use?', ['patient.name'], { order: 1 }),
  q('core.main_concern', complaintPaths, 'main_concern', 'What are you feeling today?', ['mainConcern'], { order: 2, skippable: false }),
  q('core.onset', complaintPaths, 'relevant_follow_up', 'When did this start, or when did it last change?', ['onset'], { order: 30 }),
  q('core.severity', complaintPaths, 'relevant_follow_up', 'How severe is it from 1 to 10, with 10 being the most severe?', ['severityOrActivity'], { order: 31 }),
  q('core.pattern', complaintPaths, 'relevant_follow_up', 'Is this new, recurring, or related to a condition you already know about?', ['pattern'], { order: 32 }),

  q('shoulder.area_side', ['musculoskeletal_shoulder'], 'relevant_follow_up', 'Which shoulder or body area is affected?', ['bodyAreaSide'], { order: 20 }),
  q('shoulder.cause', ['musculoskeletal_shoulder'], 'relevant_follow_up', 'Did this follow an injury, fall, lifting event, or begin gradually?', ['cause'], { order: 21 }),
  q('shoulder.movement', ['musculoskeletal_shoulder'], 'relevant_follow_up', 'Which movement or activity is limited?', ['movementLimitation'], { order: 22 }),
  q('shoulder.deformity', ['musculoskeletal_shoulder'], 'safety', 'What visible swelling or change in shape have you noticed?', ['swellingDeformity'], { order: 10, safetyPriority: 70 }),
  q('shoulder.neurovascular', ['musculoskeletal_shoulder'], 'safety', 'What changes in feeling, strength, or circulation have you noticed in that arm?', ['neurovascularConcern'], { order: 11, safetyPriority: 69 }),

  q('skin.location', ['skin'], 'relevant_follow_up', 'Where is the skin concern?', ['skinLocation'], { order: 20 }),
  q('skin.progression', ['skin'], 'relevant_follow_up', 'Is it spreading or changing?', ['skinProgression'], { order: 21 }),
  q('skin.features', ['skin'], 'relevant_follow_up', 'What other changes have you noticed in the affected skin?', ['skinFeatures'], { order: 22 }),
  q('skin.systemic', ['skin'], 'safety', 'Do you have a fever or feel unwell overall?', ['skinSystemic'], { answerType: 'yes_no', order: 12, safetyPriority: 75 }),
  q('skin.face_throat', ['skin'], 'safety', 'Do you have swelling of your face, mouth, or throat?', ['faceMouthThroatSwelling'], { answerType: 'yes_no', order: 10, safetyPriority: 100 }),
  q('skin.breathing', ['skin'], 'safety', 'Are you having difficulty breathing?', ['breathingDifficulty'], { answerType: 'yes_no', order: 11, safetyPriority: 99 }),
  q('skin.exposure', ['skin'], 'relevant_follow_up', 'Was there a recent medicine, product, food, bite, or other exposure that may be relevant?', ['skinExposure'], { order: 23 }),

  q('chest.current', ['chest'], 'safety', 'Is the chest pain or pressure happening now?', ['currentChestPain'], { answerType: 'yes_no', order: 10, safetyPriority: 120, skippable: false }),
  q('chest.breathing', ['chest'], 'safety', 'Are you having difficulty breathing?', ['breathingDifficulty'], { answerType: 'yes_no', order: 11, safetyPriority: 100 }),
  q('chest.fainting', ['chest'], 'safety', 'Have you fainted or nearly fainted?', ['fainting'], { answerType: 'yes_no', order: 12, safetyPriority: 90 }),
  q('chest.sweating', ['chest'], 'relevant_follow_up', 'Are you having unusual sweating with this concern?', ['sweating'], { answerType: 'yes_no', order: 20 }),
  q('chest.spread', ['chest'], 'relevant_follow_up', 'Does the discomfort spread to your arm, jaw, back, or another area?', ['painSpread'], { answerType: 'yes_no', order: 21 }),

  q('breathing.severe_now', ['breathing'], 'safety', 'Is the breathing difficulty severe right now?', ['severeBreathingNow'], { answerType: 'yes_no', order: 10, safetyPriority: 120, skippable: false }),
  q('breathing.speaking', ['breathing'], 'safety', 'Can you speak normally without stopping for breath?', ['speakingNormally'], { answerType: 'yes_no', order: 11, safetyPriority: 110 }),
  q('breathing.fainting', ['breathing'], 'safety', 'Have you fainted?', ['faintingSevereWeakness'], { answerType: 'yes_no', order: 12, safetyPriority: 100 }),
  q('breathing.sudden', ['breathing'], 'safety', 'Did this start suddenly or get worse quickly?', ['suddenRapidWorsening'], { answerType: 'yes_no', order: 13, safetyPriority: 90 }),
  q('breathing.chest', ['breathing'], 'safety', 'Are you having chest pain?', ['currentChestPain'], { answerType: 'yes_no', order: 14, safetyPriority: 89 }),
  q('breathing.associated', ['breathing'], 'relevant_follow_up', 'What other symptoms or known triggers have you noticed?', ['breathingAssociated'], { order: 20 }),

  q('core.final_addition', complaintPaths, 'review', "Is there anything else you'd like to add before we finish?", ['finalOpportunity'], { order: 1000, skippable: false }),
]);

export const questionById = Object.freeze(Object.fromEntries(questionSets.map(item => [item.id, item])));

export function validateQuestionSets(definitions = questionSets) {
  const ids = new Set();
  for (const item of definitions) {
    if (!item || !/^[a-z]+(?:[._][a-z]+)*$/.test(item.id || '') || ids.has(item.id)) throw new Error('Invalid or duplicate question ID');
    ids.add(item.id);
    if (!item.paths?.length || item.paths.some(path => !complaintPaths.includes(path))) throw new Error(`Invalid path for ${item.id}`);
    if (!['main_concern', 'safety', 'relevant_follow_up', 'review'].includes(item.phase)) throw new Error(`Invalid phase for ${item.id}`);
    if (typeof item.prompt !== 'string' || (item.prompt.match(/\?/g) || []).length !== 1) throw new Error(`Question must contain exactly one question: ${item.id}`);
    if (!item.requiredFacts?.length || !Number.isInteger(item.safetyPriority) || item.safetyPriority < 0) throw new Error(`Invalid question contract: ${item.id}`);
    if (item.supportedAnswerStates.some(state => !answerStates.includes(state))) throw new Error(`Invalid answer state: ${item.id}`);
  }
  return true;
}

validateQuestionSets();
