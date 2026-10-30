import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { getSkill, listSkills, parseSkill } from '../src/service/skills.js';

describe('skills', () => {
  it('splits the frontmatter from the body', () => {
    const skill = parseSkill('---\nname: demo\ndescription: Does a thing.\n---\n\n# Demo\n\nStep 1.\n');
    expect(skill).toEqual({ name: 'demo', description: 'Does a thing.', body: '# Demo\n\nStep 1.' });
  });

  it('rejects a file without name and description', () => {
    expect(() => parseSkill('# No frontmatter')).toThrow('frontmatter');
    expect(() => parseSkill('---\nname: demo\n---\nBody')).toThrow('frontmatter');
  });

  it('lists the init skill by name and description only', async () => {
    const skills = await listSkills();
    const init = skills.find((s) => s.name === 'init');
    expect(init?.description).toContain('OpenPurpose');
    expect(Object.keys(init!)).toEqual(['name', 'description']);
  });

  it('returns the full text of one skill, and not_found for an unknown one', async () => {
    expect((await getSkill('init')).body).toContain('# Get started with OpenPurpose');
    await expect(getSkill('nope')).rejects.toBeInstanceOf(AppError);
  });
});
