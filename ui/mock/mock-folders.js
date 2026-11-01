// Dev-only stand-in for the folder API (the real one is src/lib/api.js -> api.folders.*). In-memory; same error
// behaviour (empty / duplicate name, unknown id). Not shipped.
// Scenarios via URL: ?folders=demo seeds a few folders from the sample data's subreddits; default is no folders.
const MAX = 60;
const DEMO = [
  ['Dev reading', ['programming', 'webdev', 'Python', 'ExperiencedDevs']],
  ['Homelab and Linux', ['homelab', 'linux']],
  ['Recipes', ['Cooking']],
  ['Trips', ['travel', 'photography']],
];

export function createMockFolders(params, loadItems) {
  /** @type {{id:string,name:string,createdAt:number}[]} */
  let folders = [];
  const assigned = new Map(); // item id -> folder id
  let seq = 0;
  let seeding = params.get('folders') !== 'demo' ? Promise.resolve() : null;

  const seed = () => (seeding ??= seedDemo()); // one shared promise so concurrent callers wait for the seed
  async function seedDemo() {
    const items = await loadItems();
    for (const [name, subs] of DEMO) {
      const f = { id: `f_mock${++seq}`, name, createdAt: Date.now() - (10 - seq) * 86_400_000 };
      folders.push(f);
      for (const it of items) if (subs.includes(it.subreddit)) assigned.set(it.id, f.id);
    }
  }

  const clean = (name) => {
    const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX);
    if (!n) throw new Error('Folder name is empty');
    return n;
  };
  const dupe = (n, except) => folders.some((f) => f.id !== except && f.name.toLowerCase() === n.toLowerCase());

  return {
    async list() {
      await seed();
      const counts = new Map();
      for (const fid of assigned.values()) counts.set(fid, (counts.get(fid) ?? 0) + 1);
      return folders.map((f) => ({ ...f, count: counts.get(f.id) ?? 0 }));
    },
    async create(name) {
      await seed();
      const n = clean(name);
      if (dupe(n)) throw new Error(`Folder "${n}" already exists`);
      const f = { id: `f_mock${++seq}`, name: n, createdAt: Date.now() };
      folders.push(f);
      return f;
    },
    async rename(id, name) {
      await seed();
      const n = clean(name);
      const f = folders.find((x) => x.id === id);
      if (!f) throw new Error('Folder not found');
      if (dupe(n, id)) throw new Error(`Folder "${n}" already exists`);
      f.name = n;
      return { ...f };
    },
    async remove(id) {
      await seed();
      folders = folders.filter((f) => f.id !== id);
      for (const [k, v] of assigned) if (v === id) assigned.delete(k); // items are kept, just un-filed
    },
    async move(ids, folderId) {
      await seed();
      if (folderId !== null && !folders.some((f) => f.id === folderId)) throw new Error('Folder not found');
      for (const id of ids) folderId === null ? assigned.delete(id) : assigned.set(id, folderId);
    },
    async assignments() {
      await seed();
      return new Map(assigned);
    },
  };
}
