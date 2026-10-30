import { THEME_TEMPLATE } from './lab-theme-template.js';

export const KINDS = ['extension', 'skill', 'prompt', 'theme'] as const;
export type Kind = (typeof KINDS)[number];

export interface TemplateFile {
  path: string;
  content: string;
}

/** Tool names are snake_case; package names are kebab-case. */
export const toolNameFor = (name: string) => `${name.replace(/-/g, '_')}_greet`;

/** Starter package files for the chosen resource kinds. Paths are relative to the package root. */
export function scaffoldFiles(name: string, kinds: readonly Kind[]): TemplateFile[] {
  const files: TemplateFile[] = [];
  const manifest: Record<string, string[]> = {};
  const tool = toolNameFor(name);

  if (kinds.includes('extension')) {
    manifest.extensions = ['./extensions'];
    files.push({
      path: `extensions/${name}.ts`,
      content: `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "${tool}",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: \`Hello, \${params.name}!\` }], details: {} };
    },
  });

  pi.registerCommand("${name}-hello", {
    description: "Say hello from ${name}",
    handler: async (args, ctx) => {
      ctx.ui.notify(\`Hello \${args || "world"}!\`, "info");
    },
  });
}
`,
    });
  }
  if (kinds.includes('skill')) {
    manifest.skills = ['./skills'];
    files.push({
      path: `skills/${name}/SKILL.md`,
      content: `---
name: ${name}
description: Describe what this skill does and when to use it. Replace this text with a specific routing description.
---

# ${name}

Write the instructions the model should follow when this skill applies.
`,
    });
  }
  if (kinds.includes('prompt')) {
    manifest.prompts = ['./prompts'];
    files.push({
      path: `prompts/${name}.md`,
      content: `---
description: Describe what this prompt does
argument-hint: "[focus]"
---
Review the current changes. Focus on \${1:-correctness}.
`,
    });
  }
  if (kinds.includes('theme')) {
    manifest.themes = ['./themes'];
    files.push({
      path: `themes/${name}.json`,
      content: JSON.stringify({ ...THEME_TEMPLATE, name }, null, 2) + '\n',
    });
  }

  files.unshift({
    path: 'package.json',
    content:
      JSON.stringify(
        {
          name,
          version: '0.1.0',
          description: `Pi package ${name}`,
          keywords: ['pi-package'],
          pi: manifest,
        },
        null,
        2,
      ) + '\n',
  });
  return files;
}
