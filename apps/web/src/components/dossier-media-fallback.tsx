type DossierMediaFallbackProps = Readonly<{
  alt: string;
  className: string;
}>;

export function DossierMediaFallback({
  alt,
  className
}: DossierMediaFallbackProps) {
  return (
    <svg
      aria-label={alt}
      className={`${className} dossier-media-fallback`}
      role="img"
      viewBox="0 0 32 32"
    >
      <path d="M16 2 29 9v14l-13 7L3 23V9z" />
      <path d="m16 8 7 4v8l-7 4-7-4v-8z" />
    </svg>
  );
}
