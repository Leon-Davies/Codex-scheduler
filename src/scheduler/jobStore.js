'use strict';

const JOBS_KEY = 'codexScheduler.jobs.v1';

class JobStore {
  constructor(globalState) {
    this.globalState = globalState;
  }

  all() {
    const jobs = this.globalState.get(JOBS_KEY, []);
    return Array.isArray(jobs) ? jobs : [];
  }

  async replace(jobs) {
    await this.globalState.update(JOBS_KEY, jobs);
  }

  async add(job) {
    const jobs = this.all();
    jobs.push(job);
    await this.replace(jobs);
    return job;
  }

  async update(id, patch) {
    const jobs = this.all();
    const index = jobs.findIndex((job) => job.id === id);
    if (index === -1) {
      return null;
    }
    jobs[index] = { ...jobs[index], ...patch, updatedAt: Date.now() };
    await this.replace(jobs);
    return jobs[index];
  }

  async remove(id) {
    const jobs = this.all();
    const next = jobs.filter((job) => job.id !== id);
    await this.replace(next);
    return next.length !== jobs.length;
  }
}

module.exports = {
  JobStore,
  JOBS_KEY,
};
