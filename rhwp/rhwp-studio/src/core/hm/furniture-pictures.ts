/** 머리말·꼬리말 안 그림의 속성 읽기·바꾸기. 주소는 바깥 머리말·꼬리말 컨트롤 아래 목록이다. */
import type { ObjectAddress } from '../../../vendor/hm-wasm/hm_wasm';
import { extendBridge } from './api';
import type * as original from './furniture';
import { pictureProperties, setObjectProperties } from './objects-editing';

const headerFooterObject = (section: number, outerPara: number, outerCtrl: number, para: number, control: number): ObjectAddress =>
  ({ section, steps: [{ para: outerPara, control: outerCtrl, index: 0 }], para, control });

export const getHeaderFooterPictureProperties: typeof original.getHeaderFooterPictureProperties = (core, sec, outerPara, outerCtrl, innerPara, innerCtrl) =>
  pictureProperties(core, headerFooterObject(sec, outerPara, outerCtrl, innerPara, innerCtrl));

export const setHeaderFooterPictureProperties: typeof original.setHeaderFooterPictureProperties = (core, sec, outerPara, outerCtrl, innerPara, innerCtrl, props) => {
  const at = headerFooterObject(sec, outerPara, outerCtrl, innerPara, innerCtrl);
  return setObjectProperties(core, at, props, { ...pictureProperties(core, at) });
};

extendBridge({ getHeaderFooterPictureProperties, setHeaderFooterPictureProperties });
