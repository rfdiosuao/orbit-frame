export const videoModels = ['Seedance 2.0 Fast', 'Seedance 2.5'];
// Keep longer requests scoped to the documented Seedance 2.5 model.
export function videoDurationRange(model) {
  const name = String(model || '').trim().toLowerCase();
  const seedance25 = /^seedance[ _-]*2[._-]5$/.test(name) || name === 'doubao-seedance-2-5-260628';
  return seedance25 ? { min: 4, max: 30 } : { min: 1, max: 15 };
}

export function validateVideoDuration(model, duration) {
  const { min, max } = videoDurationRange(model);
  if (!Number.isInteger(duration) || duration < min || duration > max) {
    throw new Error(`duration must be ${min} to ${max} seconds for ${model || 'Seedance 2.0 Fast'}`);
  }
}
