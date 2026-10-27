import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three';

// The public source deliberately uses a small generated mascot. It contains no
// supplied portrait, model, texture, or external asset reference.
export async function loadOwnerAvatar() {
  const object = new Group();
  object.name = 'GeneratedManorOwner';
  const geometries = [
    new SphereGeometry(.34, 20, 14), new SphereGeometry(.12, 14, 10),
    new CylinderGeometry(.27, .35, .72, 16), new CylinderGeometry(.085, .1, .52, 12),
    new CylinderGeometry(.07, .09, .48, 12),
  ];
  const materials = [
    new MeshStandardMaterial({ color: '#f6c8af', roughness: .82 }),
    new MeshStandardMaterial({ color: '#694f62', roughness: .78 }),
    new MeshStandardMaterial({ color: '#efafc1', roughness: .76 }),
    new MeshStandardMaterial({ color: '#fff5e8', roughness: .8 }),
  ];
  const [head, eye, body, limb, shoe] = geometries;
  const [skin, hair, dress, cream] = materials;
  const part = (geometry, material, x, y, z, scale) => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    if (scale) mesh.scale.set(...scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    object.add(mesh);
    return mesh;
  };
  part(shoe, cream, -.14, .25, .03, [1, .6, 1.15]);
  part(shoe, cream, .14, .25, .03, [1, .6, 1.15]);
  part(limb, skin, -.14, .68, 0);
  part(limb, skin, .14, .68, 0);
  part(body, dress, 0, 1.2, 0);
  part(limb, skin, -.39, 1.28, 0, [.65, 1, .65]).rotation.z = .23;
  part(limb, skin, .39, 1.28, 0, [.65, 1, .65]).rotation.z = -.23;
  part(head, skin, 0, 1.86, 0);
  part(head, hair, 0, 2.02, -.045, [1.03, .7, 1.06]);
  part(eye, hair, -.115, 1.87, .305, [.6, 1, .35]);
  part(eye, hair, .115, 1.87, .305, [.6, 1, .35]);
  let disposed = false;
  return {
    object,
    animations: [],
    dispose() {
      if (disposed) return;
      disposed = true;
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
    },
  };
}
