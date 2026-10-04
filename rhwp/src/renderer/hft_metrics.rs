//! 한컴 번들 HFT 서체의 글자 폭. 다른 설치 서체로 글리프를 그리더라도
//! 원본 HFT 폭으로 조판하도록 보존한다.
//!
//! 신명 계열(TE*EN.HFT / TE*HG.HFT): 0x1AA 의 포인터가 0x200 폭 디렉터리를 가리키고,
//! U+0020 부터 리틀엔디언 폭 102개가 0x20A 에 저장된다 (앞의 95개가 ASCII).
//! 한글 은행은 폭 블록에 기본 폭 하나(1000, 전각)만 둔다. 폭만 옮기며 윤곽선은
//! 런타임에 사용자 PC 의 HFT 에서 읽는다 (`hft_glyphs`).

use super::font_metrics_data::{FontMetric, HangulMetric, LatinRange, MetricMatch};

// 신명 HFT 의 한글 음절은 모두 전각이다. 중복 폭 11,172개 대신
// 한 그룹짜리 행렬로 고정 폭을 나타낸다.
static ZERO_CHO: [u8; 19] = [0; 19];
static ZERO_JUNG: [u8; 21] = [0; 21];
static ZERO_JONG: [u8; 28] = [0; 28];
static FULL_EM: [u16; 1] = [1000];
static FULL_EM_HANGUL: HangulMetric = HangulMetric {
    cho_groups: 1,
    jung_groups: 1,
    jong_groups: 1,
    cho_map: &ZERO_CHO,
    jung_map: &ZERO_JUNG,
    jong_map: &ZERO_JONG,
    widths: &FULL_EM,
};

// TEDNREN.HFT
static TEDNR_ASCII: [u16; 95] = [
    400, 500, 400, 660, 660, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 660, 660,
    660, 660, 660, 660, 660, 660, 660, 660, 500, 500, 500, 1000, 500, 660, 1000, 782, 713, 764,
    771, 761, 730, 819, 771, 340, 585, 710, 689, 872, 769, 818, 719, 819, 767, 712, 746, 771, 726,
    988, 683, 716, 742, 500, 500, 500, 500, 500, 400, 662, 622, 565, 622, 618, 480, 620, 628, 294,
    294, 562, 294, 896, 627, 621, 623, 622, 467, 574, 456, 627, 567, 783, 573, 559, 649, 500, 500,
    500, 1000,
];
static TEDNR_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TEDNR_ASCII,
}];
static TEDNR: FontMetric = FontMetric {
    name: "신명 디나루",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TEDNR_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TEGGTEN.HFT
static TEGGT_ASCII: [u16; 95] = [
    400, 500, 400, 690, 690, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 690, 690,
    690, 690, 690, 690, 690, 690, 690, 690, 500, 500, 500, 1000, 500, 690, 1000, 775, 776, 773,
    835, 716, 660, 814, 833, 328, 652, 788, 661, 1073, 896, 895, 735, 854, 771, 774, 718, 894, 844,
    1147, 848, 790, 718, 500, 500, 500, 500, 500, 400, 657, 704, 589, 702, 648, 421, 701, 709, 333,
    334, 653, 333, 1085, 713, 700, 705, 704, 475, 590, 475, 706, 654, 955, 647, 653, 584, 500, 500,
    500, 1000,
];
static TEGGT_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TEGGT_ASCII,
}];
static TEGGT: FontMetric = FontMetric {
    name: "신명 견고딕",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TEGGT_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TEGMJEN.HFT
static TEGMJ_ASCII: [u16; 95] = [
    400, 500, 400, 680, 680, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 680, 680,
    680, 680, 680, 680, 680, 680, 680, 680, 500, 500, 500, 1000, 500, 680, 1000, 756, 809, 782,
    846, 790, 756, 839, 861, 457, 682, 854, 748, 996, 823, 834, 764, 836, 835, 692, 742, 833, 762,
    985, 740, 752, 703, 500, 500, 500, 500, 500, 400, 724, 757, 637, 753, 673, 453, 722, 808, 438,
    415, 792, 419, 1069, 797, 707, 774, 749, 621, 600, 546, 792, 715, 992, 730, 726, 665, 500, 500,
    500, 1000,
];
static TEGMJ_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TEGMJ_ASCII,
}];
static TEGMJ: FontMetric = FontMetric {
    name: "신명 견명조",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TEGMJ_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TEGNSEN.HFT
static TEGNS_ASCII: [u16; 95] = [
    400, 500, 400, 720, 720, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 720, 720,
    720, 720, 720, 720, 720, 720, 720, 720, 500, 500, 500, 1000, 500, 720, 1000, 871, 811, 750,
    830, 770, 734, 813, 888, 474, 711, 863, 738, 1050, 847, 770, 750, 750, 831, 631, 741, 814, 862,
    1051, 891, 858, 746, 500, 500, 500, 500, 500, 400, 689, 673, 590, 690, 630, 506, 649, 756, 429,
    378, 732, 422, 1055, 751, 632, 715, 695, 611, 609, 490, 735, 733, 941, 767, 735, 663, 500, 500,
    500, 1000,
];
static TEGNS_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TEGNS_ASCII,
}];
static TEGNS: FontMetric = FontMetric {
    name: "신명 궁서",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TEGNS_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TEJGTEN.HFT
static TEJGT_ASCII: [u16; 95] = [
    400, 500, 400, 680, 680, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 680, 680,
    680, 680, 680, 680, 680, 680, 680, 680, 500, 500, 500, 1000, 500, 680, 1000, 816, 772, 775,
    785, 714, 678, 889, 831, 319, 653, 786, 653, 1066, 895, 888, 714, 854, 775, 769, 719, 889, 779,
    1149, 847, 731, 697, 500, 500, 500, 500, 500, 400, 644, 694, 584, 696, 643, 457, 699, 703, 323,
    322, 598, 323, 1050, 700, 697, 693, 694, 458, 583, 382, 705, 634, 929, 651, 635, 527, 500, 500,
    500, 1000,
];
static TEJGT_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TEJGT_ASCII,
}];
static TEJGT: FontMetric = FontMetric {
    name: "신명 중고딕",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TEJGT_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TEJMJEN.HFT
static TEJMJ_ASCII: [u16; 95] = [
    400, 500, 400, 620, 620, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 620, 620,
    620, 620, 620, 620, 620, 620, 620, 620, 500, 500, 500, 1000, 500, 620, 1000, 821, 816, 823,
    888, 819, 789, 879, 938, 462, 647, 861, 770, 1057, 919, 881, 770, 883, 829, 728, 765, 918, 821,
    1084, 806, 805, 708, 500, 500, 500, 500, 500, 400, 654, 654, 539, 674, 594, 386, 627, 710, 380,
    363, 697, 382, 998, 709, 597, 674, 648, 515, 561, 486, 710, 636, 878, 636, 635, 580, 500, 500,
    500, 1000,
];
static TEJMJ_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TEJMJ_ASCII,
}];
static TEJMJ: FontMetric = FontMetric {
    name: "신명 중명조",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TEJMJ_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TESEGEN.HFT
static TESEG_ASCII: [u16; 95] = [
    400, 500, 400, 650, 650, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 650, 650,
    650, 650, 650, 650, 650, 650, 650, 650, 500, 500, 500, 1000, 500, 650, 1000, 720, 752, 797,
    775, 672, 613, 845, 785, 261, 587, 719, 620, 921, 784, 833, 710, 836, 749, 733, 641, 782, 689,
    1002, 666, 658, 650, 500, 500, 500, 500, 500, 400, 617, 678, 629, 677, 634, 347, 657, 637, 264,
    264, 589, 264, 945, 637, 657, 678, 677, 371, 595, 335, 637, 553, 838, 569, 548, 557, 500, 500,
    500, 1000,
];
static TESEG_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TESEG_ASCII,
}];
static TESEG: FontMetric = FontMetric {
    name: "신명 세고딕",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TESEG_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TESEMEN.HFT
static TESEM_ASCII: [u16; 95] = [
    400, 500, 400, 620, 620, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 620, 620,
    620, 620, 620, 620, 620, 620, 620, 620, 500, 500, 500, 1000, 500, 620, 1000, 787, 739, 727,
    773, 658, 661, 759, 780, 337, 485, 775, 647, 929, 789, 755, 602, 769, 726, 693, 672, 765, 767,
    978, 749, 757, 626, 500, 500, 500, 500, 500, 400, 553, 564, 520, 573, 554, 372, 560, 582, 266,
    313, 572, 318, 845, 587, 562, 573, 565, 383, 484, 345, 598, 627, 842, 598, 587, 534, 500, 500,
    500, 1000,
];
static TESEM_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TESEM_ASCII,
}];
static TESEM: FontMetric = FontMetric {
    name: "신명 세명조",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TESEM_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TESENEN.HFT
static TESEN_ASCII: [u16; 95] = [
    400, 500, 400, 650, 650, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 650, 650,
    650, 650, 650, 650, 650, 650, 650, 650, 500, 500, 500, 1000, 500, 650, 1000, 719, 752, 796,
    775, 703, 644, 845, 785, 270, 587, 714, 651, 921, 784, 833, 710, 836, 749, 734, 702, 782, 689,
    1003, 669, 657, 708, 500, 500, 500, 500, 500, 400, 648, 678, 628, 677, 634, 408, 657, 637, 274,
    274, 589, 274, 945, 637, 657, 678, 677, 402, 595, 396, 637, 559, 839, 572, 548, 614, 500, 500,
    500, 1000,
];
static TESEN_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TESEN_ASCII,
}];
static TESEN: FontMetric = FontMetric {
    name: "신명 세나루",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TESEN_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TESGREN.HFT
static TESGR_ASCII: [u16; 95] = [
    400, 500, 400, 620, 620, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 620, 620,
    620, 620, 620, 620, 620, 620, 620, 620, 500, 500, 500, 1000, 500, 620, 1000, 779, 696, 756,
    759, 694, 663, 811, 755, 299, 558, 698, 619, 867, 752, 812, 719, 808, 758, 698, 656, 754, 725,
    1010, 720, 710, 641, 500, 500, 500, 500, 500, 400, 571, 619, 521, 619, 575, 400, 573, 578, 244,
    243, 519, 243, 860, 578, 574, 577, 577, 363, 528, 315, 577, 524, 747, 550, 502, 511, 500, 500,
    500, 1000,
];
static TESGR_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TESGR_ASCII,
}];
static TESGR: FontMetric = FontMetric {
    name: "신명 신그래픽",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TESGR_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TESMJEN.HFT
static TESMJ_ASCII: [u16; 95] = [
    400, 500, 400, 640, 640, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 640, 640,
    640, 640, 640, 640, 640, 640, 640, 640, 500, 500, 500, 1000, 500, 640, 1000, 778, 780, 783,
    836, 781, 751, 836, 894, 434, 611, 818, 729, 1008, 876, 840, 731, 842, 788, 691, 726, 874, 779,
    1034, 764, 763, 670, 500, 500, 500, 500, 500, 400, 618, 619, 508, 639, 561, 374, 581, 672, 354,
    337, 659, 356, 947, 673, 563, 640, 612, 483, 528, 456, 673, 603, 835, 600, 600, 548, 500, 500,
    500, 1000,
];
static TESMJ_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TESMJ_ASCII,
}];
static TESMJ: FontMetric = FontMetric {
    name: "신명 신명조",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TESMJ_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TESMMEN.HFT
static TESMM_ASCII: [u16; 95] = [
    333, 500, 500, 500, 1000, 1000, 1000, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500,
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 1000, 658, 685, 685, 764,
    658, 606, 737, 764, 342, 395, 711, 579, 948, 764, 764, 606, 764, 632, 553, 632, 737, 658, 948,
    632, 632, 579, 500, 500, 500, 500, 500, 500, 474, 553, 474, 553, 500, 289, 553, 579, 263, 237,
    553, 263, 843, 553, 527, 527, 553, 395, 448, 309, 553, 474, 711, 527, 500, 448, 500, 500, 500,
    500,
];
static TESMM_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TESMM_ASCII,
}];
static TESMM: FontMetric = FontMetric {
    name: "신명 신문명조",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TESMM_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TESSMEN.HFT
static TESSM_ASCII: [u16; 95] = [
    400, 500, 400, 600, 600, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 500, 500, 500, 1000, 500, 600, 1000, 803, 848, 778,
    827, 775, 744, 828, 885, 441, 610, 808, 727, 994, 865, 834, 725, 835, 779, 689, 721, 863, 771,
    1015, 755, 759, 670, 500, 500, 500, 500, 500, 400, 620, 617, 514, 640, 565, 384, 581, 669, 363,
    352, 657, 366, 933, 669, 568, 639, 614, 520, 534, 461, 670, 601, 825, 598, 598, 552, 500, 500,
    500, 1000,
];
static TESSM_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TESSM_ASCII,
}];
static TESSM: FontMetric = FontMetric {
    name: "신명 신신명조",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TESSM_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TESUNEN.HFT
static TESUN_ASCII: [u16; 95] = [
    400, 500, 400, 600, 600, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 600, 600,
    600, 600, 600, 600, 600, 600, 600, 600, 500, 500, 500, 1000, 500, 600, 1000, 725, 798, 788,
    846, 771, 692, 850, 847, 374, 654, 769, 646, 961, 792, 845, 659, 854, 753, 711, 671, 834, 742,
    969, 768, 689, 683, 500, 500, 500, 500, 500, 400, 648, 705, 607, 708, 605, 389, 620, 745, 372,
    371, 703, 372, 1027, 748, 644, 706, 663, 500, 607, 451, 768, 607, 859, 644, 698, 563, 500, 500,
    500, 1000,
];
static TESUN_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TESUN_ASCII,
}];
static TESUN: FontMetric = FontMetric {
    name: "신명 순명조",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TESUN_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TETGREN.HFT
static TETGR_ASCII: [u16; 95] = [
    400, 500, 400, 650, 650, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 650, 650,
    676, 650, 650, 650, 650, 650, 650, 650, 500, 500, 500, 1000, 500, 650, 1000, 809, 726, 786,
    789, 724, 693, 841, 785, 320, 588, 728, 649, 896, 782, 842, 749, 838, 788, 728, 666, 784, 755,
    1020, 750, 740, 671, 500, 500, 500, 500, 500, 400, 601, 649, 551, 649, 605, 477, 603, 608, 274,
    273, 549, 273, 890, 608, 604, 607, 607, 393, 558, 355, 607, 554, 777, 570, 532, 541, 500, 500,
    500, 1000,
];
static TETGR_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TETGR_ASCII,
}];
static TETGR: FontMetric = FontMetric {
    name: "신명 태그래픽",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TETGR_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TETGTEN.HFT
static TETGT_ASCII: [u16; 95] = [
    400, 500, 400, 690, 690, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 690, 690,
    690, 690, 690, 690, 690, 690, 690, 690, 500, 500, 500, 1000, 500, 690, 1000, 849, 766, 826,
    829, 764, 733, 881, 825, 360, 628, 768, 689, 937, 822, 882, 789, 878, 828, 768, 706, 824, 795,
    1075, 790, 780, 711, 500, 500, 500, 500, 500, 400, 641, 689, 591, 644, 645, 417, 643, 648, 314,
    313, 589, 313, 930, 648, 644, 647, 647, 433, 598, 379, 647, 594, 817, 620, 572, 581, 500, 500,
    500, 1000,
];
static TETGT_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TETGT_ASCII,
}];
static TETGT: FontMetric = FontMetric {
    name: "신명 태고딕",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TETGT_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// TETMJEN.HFT
static TETMJ_ASCII: [u16; 95] = [
    400, 500, 400, 710, 710, 1000, 1000, 400, 500, 500, 500, 1000, 400, 500, 400, 500, 710, 710,
    710, 710, 710, 710, 710, 710, 710, 710, 500, 500, 500, 1000, 500, 710, 1000, 725, 798, 788,
    846, 771, 692, 850, 847, 374, 654, 769, 646, 961, 792, 845, 659, 854, 753, 711, 671, 834, 742,
    969, 768, 689, 683, 500, 500, 500, 500, 500, 400, 648, 705, 607, 708, 605, 389, 620, 745, 372,
    371, 703, 372, 1027, 748, 644, 706, 663, 500, 607, 451, 768, 607, 859, 644, 698, 563, 500, 500,
    500, 1000,
];
static TETMJ_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &TETMJ_ASCII,
}];
static TETMJ: FontMetric = FontMetric {
    name: "신명 태명조",
    bold: false,
    italic: false,
    em_size: 1000,
    latin_ranges: &TETMJ_LATIN,
    hangul: Some(&FULL_EM_HANGUL),
};

// HMEHL.HFT — HCI Hollyhock (like Helvetica)
static HMEHL_ASCII: [u16; 95] = [
    142, 142, 181, 284, 284, 455, 342, 113, 170, 170, 199, 298, 142, 170, 142, 142, 284, 284, 284,
    284, 284, 284, 284, 284, 284, 284, 142, 142, 298, 298, 298, 284, 520, 342, 342, 370, 370, 342,
    312, 398, 370, 142, 255, 342, 284, 426, 370, 398, 342, 398, 370, 342, 312, 370, 342, 483, 342,
    342, 312, 142, 142, 142, 240, 284, 113, 284, 284, 255, 284, 284, 142, 284, 284, 113, 113, 255,
    113, 426, 284, 284, 284, 284, 170, 255, 142, 284, 255, 370, 255, 255, 255, 171, 133, 171, 298,
];
static HMEHL_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &HMEHL_ASCII,
}];
static HMEHL: FontMetric = FontMetric {
    name: "HCI Hollyhock",
    bold: false,
    italic: false,
    em_size: 512,
    latin_ranges: &HMEHL_LATIN,
    hangul: None,
};

// HMEHLB.HFT — HCI Hollyhock Bold (like Helvetica Bold)
static HMEHLB_ASCII: [u16; 95] = [
    142, 170, 242, 284, 284, 455, 370, 142, 170, 170, 199, 298, 142, 170, 142, 142, 284, 284, 284,
    284, 284, 284, 284, 284, 284, 284, 170, 170, 298, 298, 298, 312, 499, 370, 370, 370, 370, 342,
    312, 398, 370, 142, 284, 370, 312, 426, 370, 398, 342, 398, 370, 342, 312, 370, 342, 483, 342,
    342, 312, 170, 142, 170, 298, 284, 142, 284, 312, 284, 312, 284, 170, 312, 312, 142, 142, 284,
    142, 455, 312, 312, 312, 312, 199, 284, 170, 312, 284, 398, 284, 284, 255, 199, 143, 199, 298,
];
static HMEHLB_LATIN: [LatinRange; 1] = [LatinRange {
    start: 0x20,
    end: 0x7e,
    widths: &HMEHLB_ASCII,
}];
static HMEHLB: FontMetric = FontMetric {
    name: "HCI Hollyhock",
    bold: true,
    italic: false,
    em_size: 512,
    latin_ranges: &HMEHLB_LATIN,
    hangul: None,
};

static HFT_METRICS: [&FontMetric; 19] = [
    &TEDNR, &TEGGT, &TEGMJ, &TEGNS, &TEJGT, &TEJMJ, &TESEG, &TESEM, &TESEN, &TESGR, &TESMJ, &TESMM,
    &TESSM, &TESUN, &TETGR, &TETGT, &TETMJ, &HMEHL, &HMEHLB,
];

pub(crate) fn find_metric(name: &str, bold: bool, _italic: bool) -> Option<MetricMatch> {
    let name = name.trim();
    HFT_METRICS
        .iter()
        .find(|metric| metric.name == name && metric.bold == bold)
        .or_else(|| {
            HFT_METRICS
                .iter()
                .find(|metric| metric.name == name && !metric.bold)
        })
        .map(|metric| MetricMatch {
            metric,
            bold_fallback: bold && !metric.bold,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hollyhock_keeps_source_advances_and_paired_faces() {
        let regular = find_metric("HCI Hollyhock", false, false).unwrap();
        let bold = find_metric("HCI Hollyhock", true, false).unwrap();
        assert_eq!(regular.metric.em_size, 512);
        assert_eq!(
            regular.metric.latin_ranges[0].widths[(b'2' - b' ') as usize],
            284
        );
        assert_eq!(
            regular.metric.latin_ranges[0].widths[(b'-' - b' ') as usize],
            170
        );
        assert!(bold.metric.bold);
        assert!(!bold.bold_fallback);
        assert_eq!(
            find_metric("HCI Hollyhock", true, true)
                .unwrap()
                .metric
                .latin_ranges[0]
                .widths,
            bold.metric.latin_ranges[0].widths
        );
        assert_eq!(
            crate::renderer::hft_substitute_faces("HCI Hollyhock"),
            &["Helvetica", "Arial"]
        );
        for alt_type in [0, 1, 2] {
            assert_eq!(
                crate::renderer::style_resolver::resolve_font_substitution(
                    "HCI Hollyhock",
                    alt_type,
                    1
                ),
                None
            );
        }
    }
}
