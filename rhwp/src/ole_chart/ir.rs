//! Renderer-neutral OLE chart IR export helpers.

use base64::Engine;
use serde::Serialize;

use super::OleChart;

pub const OLE_CHART_IR_SCHEMA: &str = "rhwp.oleChartIr";
pub const OLE_CHART_IR_VERSION: u32 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OleChartIrPayload<'a> {
    pub schema: &'static str,
    pub version: u32,
    pub chart: &'a OleChart,
}

impl<'a> OleChartIrPayload<'a> {
    pub fn new(chart: &'a OleChart) -> Self {
        Self {
            schema: OLE_CHART_IR_SCHEMA,
            version: OLE_CHART_IR_VERSION,
            chart,
        }
    }
}

pub fn ole_chart_ir_json(chart: &OleChart) -> Result<String, serde_json::Error> {
    serde_json::to_string(&OleChartIrPayload::new(chart))
}

pub fn ole_chart_ir_base64(chart: &OleChart) -> Result<String, serde_json::Error> {
    Ok(base64::engine::general_purpose::STANDARD.encode(ole_chart_ir_json(chart)?))
}

