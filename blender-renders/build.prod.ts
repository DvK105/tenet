import { config } from 'dotenv'
import { resolve } from 'path'
import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

// Load environment variables from .env file in project root
// When script runs, cwd is blender-renders, so go up one level
config({ path: resolve(process.cwd(), '../.env') })

async function main() {
  await Template.build(template, {
    alias: 'blender-renders',
    onBuildLogs: defaultBuildLogger(),
  });
}

main().catch(console.error);