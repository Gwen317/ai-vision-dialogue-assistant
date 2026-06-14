/**
 * CosyVoice cosyvoice-v3-flash 系统预置音色。
 * 来源：https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list
 */
export interface CosyVoicePresetVoice {
  id: string;
  name: string;
  scenario: string;
  trait: string;
}

export const DEFAULT_COSYVOICE_VOICE_ID = 'longanyang';

export const COSYVOICE_V3_FLASH_PRESETS: CosyVoicePresetVoice[] = [
  { id: 'longanyang', name: '龙安洋', scenario: '社交陪伴', trait: '阳光大男孩' },
  { id: 'longanhuan', name: '龙安欢', scenario: '社交陪伴', trait: '欢脱元气女' },
  { id: 'longhuhu_v3', name: '龙呼呼', scenario: '童声', trait: '天真烂漫女童' },
  { id: 'longpaopao_v3', name: '龙泡泡', scenario: '智能玩具', trait: '飞天泡泡音' },
  { id: 'longjielidou_v3', name: '龙杰力豆', scenario: '智能玩具', trait: '阳光顽皮男' },
  { id: 'longxian_v3', name: '龙仙', scenario: '智能玩具', trait: '豪放可爱女' },
  { id: 'longling_v3', name: '龙铃', scenario: '智能玩具', trait: '稚气呆板女' },
  { id: 'longshanshan_v3', name: '龙闪闪', scenario: '儿童有声书', trait: '戏剧化童声' },
  { id: 'longniuniu_v3', name: '龙牛牛', scenario: '儿童有声书', trait: '阳光男童声' },
  { id: 'longjiaxin_v3', name: '龙嘉欣', scenario: '方言', trait: '优雅粤语女' },
  { id: 'longjiayi_v3', name: '龙嘉怡', scenario: '方言', trait: '知性粤语女' },
  { id: 'longanyue_v3', name: '龙安粤', scenario: '方言', trait: '欢脱粤语男' },
  { id: 'longlaotie_v3', name: '龙老铁', scenario: '方言', trait: '东北直率男' },
  { id: 'longshange_v3', name: '龙陕哥', scenario: '方言', trait: '原味陕北男' },
  { id: 'longanmin_v3', name: '龙安闽', scenario: '方言', trait: '清纯萝莉女' },
  { id: 'loongkyong_v3', name: 'loongkyong', scenario: '出海营销', trait: '韩语女' },
  { id: 'loongriko_v3', name: 'Riko', scenario: '出海营销', trait: '二次元霓虹女' },
  { id: 'loongtomoka_v3', name: 'loongtomoka', scenario: '出海营销', trait: '日语女' },
  { id: 'loongabby_v3', name: 'loongabby', scenario: '出海营销', trait: '美式英文女' },
  { id: 'loongandy_v3', name: 'loongandy', scenario: '出海营销', trait: '美式英文男' },
  { id: 'loongannie_v3', name: 'loongannie', scenario: '出海营销', trait: '美式英文女' },
  { id: 'loongava_v3', name: 'loongava', scenario: '出海营销', trait: '美式英文女' },
  { id: 'loongbeth_v3', name: 'loongbeth', scenario: '出海营销', trait: '美式英文女' },
  { id: 'loongbetty_v3', name: 'loongbetty', scenario: '出海营销', trait: '美式英文女' },
  { id: 'loongcally_v3', name: 'loongcally', scenario: '出海营销', trait: '美式英文女' },
  { id: 'loongcindy_v3', name: 'loongcindy', scenario: '出海营销', trait: '美式英文女' },
  { id: 'loongdavid_v3', name: 'loongdavid', scenario: '出海营销', trait: '美式英文男' },
  { id: 'loongdonna_v3', name: 'loongdonna', scenario: '出海营销', trait: '美式英文女' },
  { id: 'loongemily_v3', name: 'loongemily', scenario: '出海营销', trait: '英式英文女' },
  { id: 'loongeric_v3', name: 'loongeric', scenario: '出海营销', trait: '英式英文男' },
  { id: 'loongluna_v3', name: 'loongluna', scenario: '出海营销', trait: '英式英文女' },
  { id: 'loongluca_v3', name: 'loongluca', scenario: '出海营销', trait: '英式英文男' },
  { id: 'loongtomoya_v3', name: 'loongtomoya', scenario: '出海营销', trait: '日语男' },
  { id: 'loongyuuna_v3', name: 'Yuuna', scenario: '出海营销', trait: '日语女' },
  { id: 'loongyuuma_v3', name: 'Yuuma', scenario: '出海营销', trait: '日语男' },
  { id: 'loongjihun_v3', name: 'Jihun', scenario: '出海营销', trait: '韩语男' },
  { id: 'loongindah_v3', name: 'loongindah', scenario: '出海营销', trait: '印尼女' },
  { id: 'longfei_v3', name: '龙飞', scenario: '诗词朗诵', trait: '热血磁性男' },
  { id: 'longyingxiao_v3', name: '龙应笑', scenario: '电话销售', trait: '清甜推销女' },
  { id: 'longyingxun_v3', name: '龙应询', scenario: '客服', trait: '年轻青涩男' },
  { id: 'longyingjing_v3', name: '龙应静', scenario: '客服', trait: '低调冷静女' },
  { id: 'longyingling_v3', name: '龙应聆', scenario: '客服', trait: '温和共情女' },
  { id: 'longyingtao_v3', name: '龙应桃', scenario: '客服', trait: '温柔淡定女' },
  { id: 'longxiaochun_v3', name: '龙小淳', scenario: '语音助手', trait: '知性积极女' },
  { id: 'longxiaoxia_v3', name: '龙小夏', scenario: '语音助手', trait: '沉稳权威女' },
  { id: 'longyumi_v3', name: 'YUMI', scenario: '语音助手', trait: '正经青年女' },
  { id: 'longanyun_v3', name: '龙安昀', scenario: '语音助手', trait: '居家暖男' },
  { id: 'longanwen_v3', name: '龙安温', scenario: '语音助手', trait: '优雅知性女' },
  { id: 'longanli_v3', name: '龙安莉', scenario: '语音助手', trait: '利落从容女' },
  { id: 'longanlang_v3', name: '龙安朗', scenario: '语音助手', trait: '清爽利落男' },
  { id: 'longyingmu_v3', name: '龙应沐', scenario: '语音助手', trait: '优雅知性女' },
  { id: 'longantai_v3', name: '龙安台', scenario: '社交陪伴', trait: '嗲甜台湾女' },
  { id: 'longhua_v3', name: '龙华', scenario: '社交陪伴', trait: '元气甜美女' },
  { id: 'longcheng_v3', name: '龙橙', scenario: '社交陪伴', trait: '智慧青年男' },
  { id: 'longze_v3', name: '龙泽', scenario: '社交陪伴', trait: '温暖元气男' },
  { id: 'longzhe_v3', name: '龙哲', scenario: '社交陪伴', trait: '呆板大暖男' },
  { id: 'longyan_v3', name: '龙颜', scenario: '社交陪伴', trait: '温暖春风女' },
  { id: 'longxing_v3', name: '龙星', scenario: '社交陪伴', trait: '温婉邻家女' },
  { id: 'longtian_v3', name: '龙天', scenario: '社交陪伴', trait: '磁性理智男' },
  { id: 'longwan_v3', name: '龙婉', scenario: '社交陪伴', trait: '细腻柔声女' },
  { id: 'longqiang_v3', name: '龙嫱', scenario: '社交陪伴', trait: '浪漫风情女' },
  { id: 'longfeifei_v3', name: '龙菲菲', scenario: '社交陪伴', trait: '甜美娇气女' },
  { id: 'longhao_v3', name: '龙浩', scenario: '社交陪伴', trait: '多情忧郁男' },
  { id: 'longanrou_v3', name: '龙安柔', scenario: '社交陪伴', trait: '温柔闺蜜女' },
  { id: 'longhan_v3', name: '龙寒', scenario: '社交陪伴', trait: '温暖痴情男' },
  { id: 'longanzhi_v3', name: '龙安智', scenario: '社交陪伴', trait: '睿智轻熟男' },
  { id: 'longanling_v3', name: '龙安灵', scenario: '社交陪伴', trait: '思维灵动女' },
  { id: 'longanya_v3', name: '龙安雅', scenario: '社交陪伴', trait: '高雅气质女' },
  { id: 'longanqin_v3', name: '龙安亲', scenario: '社交陪伴', trait: '亲和活泼女' },
  { id: 'longmiao_v3', name: '龙妙', scenario: '有声书', trait: '抑扬顿挫女' },
  { id: 'longsanshu_v3', name: '龙三叔', scenario: '有声书', trait: '沉稳质感男' },
  { id: 'longyuan_v3', name: '龙媛', scenario: '有声书', trait: '温暖治愈女' },
  { id: 'longyue_v3', name: '龙悦', scenario: '有声书', trait: '温暖磁性女' },
  { id: 'longxiu_v3', name: '龙修', scenario: '有声书', trait: '博才说书男' },
  { id: 'longnan_v3', name: '龙楠', scenario: '有声书', trait: '睿智青年男' },
  { id: 'longwanjun_v3', name: '龙婉君', scenario: '有声书', trait: '细腻柔声女' },
  { id: 'longyichen_v3', name: '龙逸尘', scenario: '有声书', trait: '洒脱活力男' },
  { id: 'longlaobo_v3', name: '龙老伯', scenario: '有声书', trait: '沧桑岁月爷' },
  { id: 'longlaoyi_v3', name: '龙老姨', scenario: '有声书', trait: '烟火从容阿姨' },
  { id: 'longjiqi_v3', name: '龙机器', scenario: '短视频配音', trait: '呆萌机器人' },
  { id: 'longhouge_v3', name: '龙猴哥', scenario: '短视频配音', trait: '经典猴哥' },
  { id: 'longdaiyu_v3', name: '龙黛玉', scenario: '短视频配音', trait: '娇率才女音' },
  { id: 'longanran_v3', name: '龙安燃', scenario: '直播带货', trait: '活泼质感女' },
  { id: 'longanxuan_v3', name: '龙安宣', scenario: '直播带货', trait: '经典直播女' },
  { id: 'longshuo_v3', name: '龙硕', scenario: '新闻播报', trait: '博才干练男' },
  { id: 'longshu_v3', name: '龙书', scenario: '新闻播报', trait: '沉稳青年男' },
  { id: 'loongbella_v3', name: 'Bella3.0', scenario: '新闻播报', trait: '精准干练女' }
];

const PRESET_VOICE_IDS = new Set(COSYVOICE_V3_FLASH_PRESETS.map((voice) => voice.id));

export function isCosyVoicePresetVoiceId(voiceId: string): boolean {
  return PRESET_VOICE_IDS.has(voiceId);
}

export function getCosyVoicePresetLabel(voiceId: string): string {
  const preset = COSYVOICE_V3_FLASH_PRESETS.find((voice) => voice.id === voiceId);
  if (!preset) {
    return voiceId;
  }
  return `${preset.name}（${preset.trait}）`;
}

export function groupCosyVoicePresetsByScenario(): Map<string, CosyVoicePresetVoice[]> {
  const groups = new Map<string, CosyVoicePresetVoice[]>();
  for (const voice of COSYVOICE_V3_FLASH_PRESETS) {
    const list = groups.get(voice.scenario) ?? [];
    list.push(voice);
    groups.set(voice.scenario, list);
  }
  return groups;
}

export function resolveCosyVoiceId(overrideVoiceId?: string): string {
  if (overrideVoiceId && PRESET_VOICE_IDS.has(overrideVoiceId)) {
    return overrideVoiceId;
  }

  const envVoice = process.env.DASHSCOPE_VOICE_ID;
  if (envVoice) {
    return envVoice;
  }

  return DEFAULT_COSYVOICE_VOICE_ID;
}

export function normalizeStoredCosyVoiceId(storedVoiceId: string | null): string {
  if (storedVoiceId && PRESET_VOICE_IDS.has(storedVoiceId)) {
    return storedVoiceId;
  }
  return DEFAULT_COSYVOICE_VOICE_ID;
}
