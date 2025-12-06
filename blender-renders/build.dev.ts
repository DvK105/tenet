import { config } from 'dotenv'
import { resolve } from 'path'
import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

// Load environment variables from .env file in project root
// When script runs, cwd is blender-renders, so go up one level
config({ path: resolve(process.cwd(), '../.env') })

async function main() {
  try {
    await Template.build(template, {
      alias: 'blender-renders-dev',
      onBuildLogs: defaultBuildLogger(),
    });
    console.log('✅ Template built successfully!');
  } catch (error) {
    console.error('❌ Build failed:', error);
    if (error instanceof Error && error.message.includes('snapshot')) {
      console.error('\n💡 Tip: This might be a transient E2B API issue. Try running the build again.');
      console.error('   If it persists, check your E2B API key and network connection.');
    }
    process.exit(1);
  }
}

main().catch(console.error);