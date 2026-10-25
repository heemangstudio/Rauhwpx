/** 그림 틀과 꾸밈을 유지하며 미지정 그림이나 기존 그림의 이미지 데이터를 바꾼다. */
import { extendBridge } from './api';
import { hu } from './core';
import { objectAddressByPath } from './objects-editing';
import type * as original from './objects';

export const assignPictureImage: typeof original.assignPictureImage = (core, section, para, path, control, bytes, width, height, extension) => {
  const object = objectAddressByPath(section, para, path, control);
  core.transact([{ op: 'assignPictureImage', object, bytes: [...bytes], extension,
    naturalWidth: hu(width), naturalHeight: hu(height) }]);
  const picture = core.query<{ binDataId: number }>({ kind: 'pictureData', object });
  return { ok: true, binDataId: picture.binDataId };
};

extendBridge({ assignPictureImage });
