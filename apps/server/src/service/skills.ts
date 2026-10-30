import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { AppError } from '../errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface SkillSummary {
  name: string;
  description: string;
}

export interface Skill extends SkillSummary {
  body: string;
}

/** The skills live in agent/skills/<name>/SKILL.md, the same files people can install by hand. */
export function skillsDir(): string {
  return process.env.OPENPURPOSE_SKILLS_DIR ?? path.resolve(here, '../../../../agent/skills');
}

/** Splits a SKILL.md into the name and description of its frontmatter and the markdown body. */
export function parseSkill(source: string): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  const meta = m ? (parse(m[1]) as Partial<SkillSummary> | null) : null;
  if (!m || !meta?.name || !meta.description) {
    throw new Error('SKILL.md needs a frontmatter with name and description');
  }
  return { name: meta.name, description: meta.description, body: m[2].trim() };
}

async function readSkills(): Promise<Skill[]> {
  const dir = skillsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries.sort()) {
    try {
      skills.push(parseSkill(await readFile(path.join(dir, entry, 'SKILL.md'), 'utf8')));
    } catch {
      // Not a skill folder, or a broken one: skip it instead of failing the whole list.
    }
  }
  return skills;
}

export async function listSkills(): Promise<SkillSummary[]> {
  return (await readSkills()).map(({ name, description }) => ({ name, description }));
}

export async function getSkill(name: string): Promise<Skill> {
  const skill = (await readSkills()).find((s) => s.name === name);
  if (!skill) throw new AppError('not_found', `Skill "${name}" not found. Call list_skills.`);
  return skill;
}
