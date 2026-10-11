import { exampleModel } from '../../public/model.js';

export function sizedModel(nodeCount = 201, streamCount = 501) {
  const model = exampleModel();
  while (model.nodes.length < nodeCount) {
    const index = model.nodes.length;
    model.nodes.push({ id: `unit-${index}`, kind: 'process', name: `Unit ${index}`, x: (index % 20) * 150, y: Math.floor(index / 20) * 150 });
  }
  while (model.streams.length < streamCount) {
    const index = model.streams.length;
    model.streams.push({ ...model.streams[0], id: `stream-${index}`, name: `Stream ${index}` });
  }
  return model;
}
