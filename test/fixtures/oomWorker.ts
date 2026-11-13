// A worker that exhausts its heap limit with many small, retained objects (old-generation growth, which is what the
// parent's memory limit caps). Large single arrays would trip a different limit first.
const keep: { a: number; b: number[]; c: string }[] = [];
for (let i = 0; ; i++) keep.push({ a: i, b: [i, i + 1, i + 2], c: "row " + i });
