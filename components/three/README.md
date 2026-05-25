# components/three

Reusable building blocks of the persistent Forge world.

- **ForgeCore** — the central reactive icosahedron + emissive shell.
- **ParticleLattice** — the surrounding instanced point cloud / neural lattice.
- **PostFX** — bloom + vignette composer; auto-disabled on small viewports.

Anything visible *inside the canvas* lives here. DOM overlays (forms, buttons,
text) live in `components/` at the top level so they stay sharp and accessible.

When adding a new scene piece:

1. Keep geometries / materials disposed in a `useEffect` cleanup.
2. Read app state from `useForgeStore` rather than from props — the world is
   persistent and the active route shouldn't have to thread props down.
3. Prefer `InstancedMesh` or `Points` over many `mesh` children.
