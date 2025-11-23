import { Template } from 'e2b'
import { join } from 'path'

// Create template from Dockerfile
export const template = Template().fromDockerfile(join(__dirname, 'Dockerfile'))
