const NotFound = () => {
  return (
    <div className="page flex min-h-[60vh] items-center justify-center">
      <div className="plate ticked max-w-md p-8 text-center">
        <div className="eyebrow eyebrow-amber justify-center">Error 404</div>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-foreground">
          Page not found
        </h1>
        <p className="mb-5 mt-2 text-base text-muted-foreground">
          This route does not exist on the console.
        </p>
        <a
          href="/"
          className="font-semibold text-primary underline-offset-4 hover:underline"
        >
          Return to dashboard
        </a>
      </div>
    </div>
  );
};

export default NotFound;
