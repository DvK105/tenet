# Tenet v2 (Blender Render Engine)

Tenet is a Next.js app that lets you upload a `.blend` file and renders it to an MP4 using Blender running inside E2B sandboxes. Rendering is orchestrated asynchronously via Inngest so web requests stay fast and don't time out.

## Architecture Overview

Tenet follows a **service-oriented architecture** with clear separation of concerns:

```
┌─────────────┐
│  API Routes │  ← Thin request handlers
└──────┬──────┘
       │
┌──────▼──────────────────┐
│    Service Layer        │  ← Business logic
│  - BlenderService       │
│  - SandboxService       │
│  - RenderService        │
│  - StorageService       │
│  - JobStatusService     │
└──────┬──────────────────┘
       │
┌──────▼──────────────────┐
│   Core Infrastructure   │
│  - E2B Sandboxes        │
│  - Supabase Storage     │
│  - Inngest Functions    │
└─────────────────────────┘
```

### Project Structure

```
src/
├── types/              # TypeScript type definitions
│   ├── api.types.ts
│   ├── blender.types.ts
│   ├── render-job.types.ts
│   ├── sandbox.types.ts
│   └── storage.types.ts
├── services/           # Business logic services
│   ├── blender.service.ts      # Blender operations
│   ├── sandbox.service.ts      # E2B sandbox management
│   ├── render.service.ts       # Render status/progress
│   ├── storage.service.ts      # Storage abstraction
│   └── job-status.service.ts   # Job status management
├── config/             # Configuration management
│   ├── app.config.ts          # App-wide config
│   └── blender.config.ts      # Blender-specific config
├── lib/
│   ├── errors/         # Error handling
│   │   ├── render-errors.ts   # Custom error classes
│   │   └── error-parser.ts    # Error parsing utilities
│   ├── utils/          # Utility functions
│   │   ├── json-parser.util.ts
│   │   ├── sandbox-output.util.ts
│   │   └── progress-calculator.util.ts
│   └── auth/           # Authentication (Clerk ready)
│       ├── types.ts
│       └── middleware.ts
├── app/
│   └── api/            # API routes (thin handlers)
└── components/         # React components
```

## Request / Render Flow

1. **Upload** (`src/app/api/upload-blender/route.ts`)
   - Validates file (`.blend` only)
   - Creates E2B sandbox via `SandboxService`
   - Uploads `.blend` to sandbox via `SandboxService`
   - Optionally extracts frame data via `BlenderService`
   - Triggers Inngest event `render/invoked` with `{ sandboxId, frameData?, parallelChunks? }`

2. **Render Orchestration** (`src/inngest/functions.ts`)
   - Connects to sandbox via `SandboxService`
   - Uploads render script via `SandboxService`
   - Executes Blender render via `BlenderService`
   - Reads MP4 from sandbox via `SandboxService`
   - Stores video via `StorageService` (Supabase or local)
   - Cleans up sandbox via `SandboxService`

3. **Status Checking** (`src/app/api/render-status/route.ts` or `src/app/api/render-events/route.ts`)
   - Uses `JobStatusService` to check status
   - Checks Supabase Storage first (via `StorageService`)
   - Falls back to local storage
   - Finally checks sandbox progress file
   - Returns unified `RenderStatus` object

4. **Manual Trigger** (`src/app/api/trigger-render/route.ts`)
   - Sends the `render/invoked` event when you already have a `sandboxId`

## Services

### BlenderService (`src/services/blender.service.ts`)
Handles all Blender operations:
- Frame extraction from `.blend` files
- Blender command execution
- Render output parsing
- Error detection (segfaults, timeouts)

### SandboxService (`src/services/sandbox.service.ts`)
Manages E2B sandbox lifecycle:
- Sandbox creation and connection
- File upload/download
- Script upload
- Command execution
- Sandbox cleanup

### StorageService (`src/services/storage.service.ts`)
Unified storage interface:
- Abstracts Supabase Storage and local filesystem
- Handles public/signed URLs
- File existence checking
- Consistent API regardless of storage backend

### RenderService (`src/services/render.service.ts`)
Render orchestration:
- Status checking (Supabase → local → sandbox)
- Progress calculation
- ETA estimation

### JobStatusService (`src/services/job-status.service.ts`)
Job status management:
- Centralized status checking
- Batch status checks
- Error handling

## Error Handling

Custom error classes in `src/lib/errors/`:
- `BlenderError` - Blender-specific errors (segfaults, timeouts, script errors)
- `SandboxError` - E2B sandbox errors
- `StorageError` - Storage operation errors
- `RenderJobError` - Render job errors

All errors include context and recovery suggestions.

## Configuration

Centralized configuration in `src/config/`:

- **`app.config.ts`** - Application-wide settings
  - Supabase configuration
  - Storage bucket names
  - Feature flags
  - API timeouts

- **`blender.config.ts`** - Blender-specific settings
  - Script paths
  - Timeouts (extraction: 120s, render: 36000s)
  - Command templates
  - Environment variables

## Type System

Centralized TypeScript types in `src/types/`:
- `RenderJob`, `RenderStatus`, `FrameData`
- `SandboxCommandResult`, `SandboxProgress`
- `BlenderRenderResult`, `BlendFrameData`
- `StorageFile`, `StorageService` interface
- API request/response types

## Parallel Rendering (Optional)

To reduce wall-clock render time, you can split renders across multiple sandboxes:

- **Enable**: `POST /api/upload-blender?parallelChunks=10`
- **How it works**:
  - Frame range is split into N contiguous ranges
  - Each chunk sandbox renders its range
  - Chunk MP4s are merged with `ffmpeg`
  - Fallback to re-encode if stream-copy fails

## Blender Scripts

Scripts in `e2b-template/`:

- **`render_mp4.py`**
  - Loads `.blend` and renders animation to MP4
  - Writes progress to `/tmp/render_progress.json`
  - Supports environment variables for customization

- **`extract_frames.py`**
  - Extracts frame data from `.blend` files
  - Outputs JSON with `frame_start`, `frame_end`, `fps`

- **`read_blend_header.py`**
  - Fallback method for reading frame data
  - Used when Blender crashes on file open

## Environment Variables

### Required (if using Supabase)
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key (server-side)
- `NEXT_PUBLIC_SUPABASE_URL` - Public URL (client-side)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Anon key (client-side)

### Optional
- `SUPABASE_STORAGE_BUCKET` - Renders bucket name (default: `renders`)
- `SUPABASE_STORAGE_PUBLIC` - Set to `1` for public bucket
- `SUPABASE_INPUTS_BUCKET` - Input files bucket (default: `blends`)
- `SUPABASE_INPUTS_PUBLIC` - Set to `1` for public inputs bucket
- `E2B_TEMPLATE` - E2B template name (default: `blender-headless-template`)
- `E2B_DEFAULT_TIMEOUT_MS` - Sandbox timeout in ms (default: 3600000)

## Development

### Prerequisites
- Node.js 20+
- npm or bun
- E2B account and API key
- (Optional) Supabase account for storage

### Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   # or
   bun install
   ```

3. Set up environment variables (see above)

4. Run development server:
   ```bash
   npm run dev
   # or
   bun run dev
   ```

5. Open `http://localhost:3000`

### Project Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint

## Supabase Storage Setup (Recommended)

1. Create a Supabase project
2. Create Storage buckets:
   - `renders` (or custom name via `SUPABASE_STORAGE_BUCKET`)
   - `blends` (or custom name via `SUPABASE_INPUTS_BUCKET`)
3. Set bucket policies (public or private)
4. Configure environment variables

If Supabase is not configured, Tenet falls back to local storage in `public/renders/`.

## Authentication (Future)

The project is structured for Clerk authentication integration:

- `src/lib/auth/types.ts` - Authentication types
- `src/lib/auth/middleware.ts` - Route protection utilities

Services accept optional `UserContext` for user-scoped operations.

## Key Improvements

### Code Organization
- **Service layer** - Business logic separated from API routes
- **Type safety** - Comprehensive TypeScript types
- **Error handling** - Custom error classes with context
- **Configuration** - Centralized config management

### Maintainability
- **Reduced duplication** - Shared utilities and services
- **Clear separation** - Each service has a single responsibility
- **Easier testing** - Services can be tested independently
- **Better error messages** - Detailed context and suggestions

### Scalability
- **Storage abstraction** - Easy to switch storage backends
- **Auth-ready** - Structured for Clerk integration
- **Extensible** - Easy to add new services and features

## Troubleshooting

### Blender Crashes (Segfault)
- File may contain incompatible features
- Try simplifying the file in Blender GUI
- Check for complex physics simulations
- Verify file format compatibility

### Render Timeouts
- Reduce frame count or complexity
- Lower resolution or quality settings
- Split animation into smaller segments
- Check timeout settings in `blender.config.ts`

### Storage Errors
- Verify Supabase credentials
- Check bucket permissions
- Ensure buckets exist
- Fall back to local storage if needed
