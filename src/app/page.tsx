export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-xl space-y-6 rounded-xl border border-border bg-card p-6 shadow-md">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Blend renderer</h1>
          <p className="text-sm text-muted-foreground">
            Upload a <code>.blend</code> file, then we&apos;ll send it to Modal
            to render using the scene&apos;s own settings.
          </p>
        </div>
        <form
          className="space-y-4"
          action="/api/upload-blend"
          method="post"
          encType="multipart/form-data"
        >
          <input
            type="file"
            name="file"
            accept=".blend"
            className="block w-full text-sm text-muted-foreground file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
          />
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Upload (manual render trigger via API)
          </button>
        </form>
        <p className="text-xs text-muted-foreground">
          Note: for a smoother UX, you can replace this simple HTML form with a
          client component that calls <code>/api/upload-blend</code> and{" "}
          <code>/api/render-blend</code> via <code>fetch</code>, then displays
          the returned image URL.
        </p>
      </div>
    </main>
  );
}
