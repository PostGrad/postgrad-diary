export const SITE_TITLE = "PostGrad's Diary";
export const SITE_DESCRIPTION =
  'Here you can find learning notes and field stories from building realtime systems, backend integrations, AI tooling and production software.';
export const AUTHOR_NAME = 'Pranay S. Patel';

export function withBase(path = '/') {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  if (normalizedPath === '/') {
    return base || '/';
  }

  return `${base}${normalizedPath}`;
}
