import { getCollection } from 'astro:content';

export async function getPublishedPosts() {
  const posts = await getCollection('blogs', ({ data }) => !data.draft);

  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium'
  }).format(date);
}

export function getReadingTime(body: string) {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.ceil(words / 220));

  return `${minutes} min read`;
}

