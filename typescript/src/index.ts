import { createOpenUrl } from './core.js';
import { createEngine, createDecoder } from './engines.js';
export type { Database, OpenOptions, Value, Row } from './core.js';

export const openUrl = createOpenUrl({ createEngine, createDecoder });
export { openUrl as open_url };
