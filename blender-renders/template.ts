import { Template } from 'e2b'
import { join } from 'path'

// Create template from custom E2B Dockerfile
export const template = Template().fromDockerfile(join(__dirname, 'e2b.dockerfile'))
