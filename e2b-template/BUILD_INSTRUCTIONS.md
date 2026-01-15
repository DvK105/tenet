# E2B Template Build Instructions

## Prerequisites

1. Install E2B CLI:
   ```bash
   npm install -g @e2b/cli@latest
   ```

2. Ensure you have E2B API key set in your environment:
   ```bash
   export E2B_API_KEY=your_api_key_here
   ```
   Or add it to your `.env` file in the project root.

## Building the Template

1. Navigate to the template directory:
   ```bash
   cd e2b-template
   ```

2. Build the template:
   ```bash
   e2b template build --name "blender-headless-template"
   ```

3. Wait for the build to complete. This will:
   - Build the Docker image
   - Push it to E2B's cloud
   - Create a sandbox snapshot
   - Register the template with the name "blender-headless-template"

## Verifying the Build

After building, you can verify the template exists by checking your E2B dashboard or by trying to create a sandbox with the template name in your code.

## Updating the Template

If you make changes to `e2b.Dockerfile` or `extract_frames.py`, rebuild the template:
```bash
cd e2b-template
e2b template build --name "blender-headless-template"
```

Note: The template name must match what's used in the code (`blender-headless-template`).
