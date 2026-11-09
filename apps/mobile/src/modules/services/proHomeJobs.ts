/**
 * [OWNER-ASKS · owner ruling 9 Nov 2026 ~20:1xZ (A)] An independent service pro goes to customers' homes: new home jobs
 * need the pro's profile photo AND a person's check of it against the approved ID (the server refuses them until then,
 * PRO_HOME_JOBS_PAUSED). The pro's own screen says what to add. `homeJobs` comes from GET /services/providers/me; an
 * older server omits it and nothing is shown.
 */
export interface ProHomeJobs { photo?: boolean; photoChecked?: boolean }
export interface ProHomeJobsCard { title: string; body: string; action: 'TAKE_PHOTO' | null }

export function proHomeJobsCard(homeJobs: ProHomeJobs | null | undefined): ProHomeJobsCard | null {
  if (!homeJobs || typeof homeJobs.photo !== 'boolean') return null;
  if (!homeJobs.photo) {
    return {
      title: 'Home jobs need your profile photo',
      body: 'Customers see your profile photo, so they know who is coming to their home. Until you take it, you can’t take new home jobs.',
      action: 'TAKE_PHOTO',
    };
  }
  if (homeJobs.photoChecked === false) {
    return {
      title: 'Your photo is being checked',
      body: 'Our team is checking your profile photo against your approved ID. New home jobs are paused until then; there is nothing to send.',
      action: null,
    };
  }
  return null;
}
