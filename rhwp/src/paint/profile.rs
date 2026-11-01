/// Layer builder/profile 힌트
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RenderProfile {
    FastPreview,
    #[default]
    Screen,
    Print,
    HighQuality,
}

impl RenderProfile {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "fastPreview" | "fast-preview" => Some(Self::FastPreview),
            "screen" => Some(Self::Screen),
            "print" => Some(Self::Print),
            "highQuality" | "high-quality" => Some(Self::HighQuality),
            _ => None,
        }
    }

    pub fn shows_editor_visuals(self) -> bool {
        matches!(self, Self::FastPreview | Self::Screen)
    }
}

