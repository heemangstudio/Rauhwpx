use crate::wmf::{imports::*, parser::*};

#[derive(Clone, Debug)]
pub enum GraphicsObject {
    Brush(Brush),
    Font(Font),
    Palette(Palette),
    Pen(Pen),
    Region(Region),
    Null,
}

/// WMF 객체 테이블 (MS-WMF 3.1.4.1).
///
/// 헤더의 `NumberOfObjects` 개 슬롯을 두고, 새 객체는 가장 낮은 번호의 빈 슬롯에
/// 들어가며 테이블이 가득 차면 버려진다. 슬롯 수는 신뢰할 수 없는 헤더 값이므로
/// 슬롯을 미리 채우지 않고 실제로 쓰인 만큼만 늘리며, 빈 슬롯은 집합으로 관리해
/// 생성 레코드마다 테이블 전체를 훑지 않는다.
#[derive(Clone, Debug)]
pub struct GraphicsObjects {
    /// 한 번이라도 쓰인 슬롯. 이 뒤(`len..capacity`)는 모두 빈 슬롯이다.
    slots: Vec<GraphicsObject>,
    /// `slots` 안의 빈(Null) 슬롯 번호.
    free: BTreeSet<usize>,
    /// 헤더가 선언한 슬롯 수.
    capacity: usize,
    null: GraphicsObject,
}

impl Default for GraphicsObjects {
    fn default() -> Self {
        Self::new(0)
    }
}

impl GraphicsObjects {
    pub fn new(v: usize) -> Self {
        Self {
            slots: Vec::new(),
            free: BTreeSet::new(),
            capacity: v,
            null: GraphicsObject::Null,
        }
    }

    /// 범위 밖 번호는 무시한다 (`get`/`push` 와 같은 관용 규칙). 헤더가 객체 수를
    /// 적게 선언한 파일이 흔하므로 패닉하면 안 된다.
    pub fn delete(&mut self, i: usize) {
        if let Some(slot) = self.slots.get_mut(i) {
            *slot = GraphicsObject::Null;
            self.free.insert(i);
        }
    }

    pub fn get(&self, i: usize) -> &GraphicsObject {
        self.slots.get(i).unwrap_or(&self.null)
    }

    pub fn push(&mut self, g: GraphicsObject) {
        if let Some(i) = self.free.pop_first() {
            self.slots[i] = g;
        } else if self.slots.len() < self.capacity {
            self.slots.push(g);
        }
    }
}

#[derive(Clone, Debug)]
pub struct SelectedGraphicsObject {
    pub brush: Brush,
    pub font: Font,
    pub palette: Option<Palette>,
    pub pen: Pen,
    pub region: Option<Region>,
}

impl Default for SelectedGraphicsObject {
    fn default() -> Self {
        SelectedGraphicsObject {
            brush: Brush::Null,
            font: Font {
                height: 12,
                width: 12,
                escapement: 0,
                orientation: 0,
                weight: 0,
                italic: false,
                underline: false,
                strike_out: false,
                charset: CharacterSet::ANSI_CHARSET,
                out_precision: OutPrecision::OUT_DEFAULT_PRECIS,
                clip_precision: ClipPrecision::CLIP_DEFAULT_PRECIS,
                quality: FontQuality::DEFAULT_QUALITY,
                pitch_and_family: PitchAndFamily {
                    family: FamilyFont::FF_DONTCARE,
                    pitch: PitchFont::DEFAULT_PITCH,
                },
                facename: "System".to_owned(),
                fallback_facename: vec!["System".to_owned()],
            },
            palette: None,
            pen: Pen {
                style: PenStyleSubsection {
                    style: PenStyle::PS_SOLID,
                    end_cap: PenStyle::PS_ENDCAP_FLAT,
                    line_join: PenStyle::PS_JOIN_MITER,
                    typ: PenStyle::PS_SOLID,
                },
                width: PointS { x: 1, y: 0 },
                color_ref: ColorRef::black(),
            },
            region: None,
        }
    }
}

impl SelectedGraphicsObject {
    pub fn brush(mut self, brush: Brush) -> Self {
        self.brush = brush;
        self
    }

    pub fn font(mut self, font: Font) -> Self {
        self.font = font;
        self
    }

    pub fn palette(mut self, palette: Palette) -> Self {
        self.palette = palette.into();
        self
    }

    pub fn pen(mut self, pen: Pen) -> Self {
        self.pen = pen;
        self
    }

    pub fn region(mut self, region: Region) -> Self {
        self.region = region.into();
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn palette(start: u16) -> GraphicsObject {
        GraphicsObject::Palette(Palette {
            start,
            number_of_entries: 0,
            a_palette_entries: vec![],
        })
    }

    fn palette_start(table: &GraphicsObjects, i: usize) -> Option<u16> {
        match table.get(i) {
            GraphicsObject::Palette(p) => Some(p.start),
            _ => None,
        }
    }

    /// MS-WMF 3.1.4.1: 새 객체는 가장 낮은 번호의 빈 슬롯에 들어가고, 가득 차면
    /// 버려진다. 범위 밖 삭제는 무시한다(예전에는 Vec 색인 패닉).
    #[test]
    fn object_table_reuses_lowest_free_slot_and_ignores_out_of_range_deletes() {
        let mut table = GraphicsObjects::new(3);
        table.delete(5);
        table.delete(usize::MAX);

        table.push(palette(0));
        table.push(palette(1));
        table.push(palette(2));
        table.push(palette(3)); // 가득 참 → 버림
        assert_eq!(
            (0..4).map(|i| palette_start(&table, i)).collect::<Vec<_>>(),
            [Some(0), Some(1), Some(2), None]
        );

        table.delete(2);
        table.delete(0);
        table.push(palette(10));
        table.push(palette(11));
        assert_eq!(palette_start(&table, 0), Some(10));
        assert_eq!(palette_start(&table, 1), Some(1));
        assert_eq!(palette_start(&table, 2), Some(11));

        let mut empty = GraphicsObjects::new(0);
        empty.delete(0);
        empty.push(palette(0));
        assert!(matches!(empty.get(0), GraphicsObject::Null));
    }
}
