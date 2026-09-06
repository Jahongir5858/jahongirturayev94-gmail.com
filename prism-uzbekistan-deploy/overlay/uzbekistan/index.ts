import { merge } from 'lodash';

import boundarySources from '../shared/universal-admin-boundaries.json';
import boundaryViz from '../global/boundary-viz.json';
import appConfig from './prism.json';

const viz = boundaryViz as Record<string, object>;
const boundaries = Object.fromEntries(
  Object.entries(boundarySources).map(([key, source]) => [
    key,
    merge({}, source, viz[key] ?? {}),
  ]),
);

const rawLayers = {
  ...boundaries,
};

const rawTables = {};
const rawReports = {};

// English is always provided by PRISM shared translations. Russian is enabled
// as an additional Central Asia-friendly interface language for this bootstrap.
const translation = { ru: {} };

export default {
  appConfig,
  rawLayers,
  rawTables,
  rawReports,
  translation,
  defaultBoundariesFile: 'adm0_simplified.json',
};
