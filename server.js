const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) console.warn("WARNING: Set ADMIN_PASSWORD in Render environment variables.");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

// Yahan limit 2mb se badha kar 20mb kar di gayi hai taaki photos submit ho sakein
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

function id(len=12){ return crypto.randomBytes(16).toString("base64url").slice(0,len); }
function admin(req,res,next){
  const p = req.headers["x-admin-password"] || req.body?.password || req.query?.password;
  if (!ADMIN_PASSWORD || p !== ADMIN_PASSWORD) return res.status(401).json({error:"Invalid admin password."});
  next();
}
function sanitizeTest(raw){
  if(!raw?.title || !Array.isArray(raw.questions)) throw new Error("Invalid test file.");
  return {
    id:String(raw.id||id(8)), title:String(raw.title), subtitle:String(raw.subtitle||"Class XI • History"),
    subject:String(raw.subject||"History"), chapter:String(raw.chapter||""),
    durationMinutes:Number(raw.durationMinutes||50),
    instructions:Array.isArray(raw.instructions)?raw.instructions.map(String):[],
    questions:raw.questions.map((q,i)=>({
      id:String(q.id||`q${i+1}`), type:q.type==="subjective"?"subjective":"mcq",
      difficulty:["Easy","Moderate","Hard","Very Hard"].includes(q.difficulty)?q.difficulty:"Moderate",
      marks:Number(q.marks||(q.type==="subjective"?5:1)), question:String(q.question||""),
      options:Array.isArray(q.options)?q.options.map(String):[], answer:q.answer??null,
      explanation:String(q.explanation||""), modelAnswer:String(q.modelAnswer||"")
    }))
  };
}
async function initDb(){
  if(!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for permanent storage.");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tests(
      id TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT, subject TEXT, chapter TEXT,
      duration_minutes INTEGER NOT NULL, instructions JSONB NOT NULL, questions JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS submissions(
      id TEXT PRIMARY KEY, test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
      name TEXT NOT NULL, started_at TIMESTAMPTZ, submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      auto_score INTEGER NOT NULL DEFAULT 0, auto_max INTEGER NOT NULL DEFAULT 0,
      subjective_score INTEGER, subjective_max INTEGER, total_score INTEGER,
      answers JSONB NOT NULL, feedback JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS answer_photos(
      id BIGSERIAL PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL, mime_type TEXT NOT NULL, image_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
function publicTest(t){
  return {...t, questions:t.questions.map(q=>({...q,answer:undefined,modelAnswer:undefined}))};
}

app.get("/api/test/:id", async(req,res)=>{
  try{
    const {rows}=await pool.query("SELECT * FROM tests WHERE id=$1",[req.params.id]);
    if(!rows[0]) return res.status(404).json({error:"Test not found."});
    const r=rows[0], t={id:r.id,title:r.title,subtitle:r.subtitle,subject:r.subject,chapter:r.chapter,
      durationMinutes:r.duration_minutes,instructions:r.instructions,questions:r.questions};
    res.json(publicTest(t));
  }catch(e){res.status(500).json({error:"Database error."})}
});

app.post("/api/admin/import",admin,upload.single("testFile"),async(req,res)=>{
  try{
    if(!req.file) throw new Error("Choose a .json test file.");
    const t=sanitizeTest(JSON.parse(req.file.buffer.toString("utf8")));
    await pool.query(`INSERT INTO tests(id,title,subtitle,subject,chapter,duration_minutes,instructions,questions)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,subtitle=EXCLUDED.subtitle,subject=EXCLUDED.subject,
      chapter=EXCLUDED.chapter,duration_minutes=EXCLUDED.duration_minutes,instructions=EXCLUDED.instructions,questions=EXCLUDED.questions`,
      [t.id,t.title,t.subtitle,t.subject,t.chapter,t.durationMinutes,JSON.stringify(t.instructions),JSON.stringify(t.questions)]);
    res.json({ok:true,id:t.id,url:`/test/${t.id}`,title:t.title,count:t.questions.length});
  }catch(e){res.status(400).json({error:e.message})}
});

app.get("/api/admin/tests",admin,async(req,res)=>{
  try{
    const {rows}=await pool.query(`
      SELECT t.id,t.title,t.chapter,jsonb_array_length(t.questions) count,
      (SELECT COUNT(*) FROM submissions s WHERE s.test_id=t.id) submissions
      FROM tests t ORDER BY t.created_at DESC`);
    res.json(rows);
  }catch(e){res.status(500).json({error:"Database error."})}
});

app.get("/api/admin/submissions/:testId",admin,async(req,res)=>{
  try{
    const {rows}=await pool.query(`SELECT id,test_id,"name",started_at,submitted_at,auto_score,auto_max,
      subjective_score,subjective_max,total_score,answers,feedback
      FROM submissions WHERE test_id=$1 ORDER BY submitted_at DESC`,[req.params.testId]);
    res.json(rows);
  }catch(e){res.status(500).json({error:"Database error."})}
});

app.get("/api/result/:id",async(req,res)=>{
  try{
    const sres=await pool.query("SELECT * FROM submissions WHERE id=$1",[req.params.id]);
    if(!sres.rows[0]) return res.status(404).json({error:"Result not found."});
    const s=sres.rows[0], tres=await pool.query("SELECT * FROM tests WHERE id=$1",[s.test_id]);
    const t=tres.rows[0];
    res.json({submission:{id:s.id,testId:s.test_id,name:s.name,startedAt:s.started_at,submittedAt:s.submitted_at,
      autoScore:s.auto_score,autoMax:s.auto_max,subjectiveScore:s.subjective_score,subjectiveMax:s.subjective_max,
      totalScore:s.total_score,answers:s.answers,feedback:s.feedback},test:{id:t.id,title:t.title,subtitle:t.subtitle,
      subject:t.subject,chapter:t.chapter,durationMinutes:t.duration_minutes,instructions:t.instructions,questions:t.questions}});
  }catch(e){res.status(500).json({error:"Database error."})}
});

app.get("/api/photo/:submissionId/:questionId",async(req,res)=>{
  try{
    const {rows}=await pool.query("SELECT mime_type,image_data FROM answer_photos WHERE submission_id=$1 AND question_id=$2 ORDER BY id DESC LIMIT 1",
      [req.params.submissionId,req.params.questionId]);
    if(!rows[0]) return res.status(404).end();
    res.set("Content-Type",rows[0].mime_type).send(rows[0].image_data);
  }catch(e){res.status(500).end()}
});

app.post("/api/submit",async(req,res)=>{
  const client=await pool.connect();
  try{
    const {testId,name,answers,startedAt}=req.body;
    const tr=await client.query("SELECT * FROM tests WHERE id=$1",[testId]);
    if(!tr.rows[0]) return res.status(404).json({error:"Test not found."});
    if(!name || !Array.isArray(answers)) return res.status(400).json({error:"Missing submission data."});
    const t=tr.rows[0];
    let autoScore=0,autoMax=0;
    const evaluated=t.questions.map(q=>{
      if(q.type!=="mcq") return {questionId:q.id,type:q.type,answer:answers.find(a=>a.questionId===q.id)?.answer??null};
      autoMax+=q.marks;
      const a=answers.find(x=>x.questionId===q.id), selected=a?.answer??null;
      const correct=String(selected)===String(q.answer);
      if(correct) autoScore+=q.marks;
      return {questionId:q.id,type:q.type,answer:selected,correct,marks:correct?q.marks:0};
    });
    const sid=id();
    await client.query("BEGIN");
    await client.query(`INSERT INTO submissions(id,test_id,name,started_at,auto_score,auto_max,answers)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [sid,testId,String(name).slice(0,100),startedAt||null,autoScore,autoMax,JSON.stringify(evaluated)]);
    for(const a of answers){
      if(typeof a.answer==="string" && a.answer.startsWith("data:image/")){
        const m=a.answer.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
        if(m){
          const buf=Buffer.from(m[2],"base64");
          if(buf.length<=8*1024*1024)
            await client.query("INSERT INTO answer_photos(submission_id,question_id,mime_type,image_data) VALUES($1,$2,$3,$4)",
              [sid,a.questionId,m[1],buf]);
        }
      }
    }
    await client.query("COMMIT");
    res.json({ok:true,submissionId:sid,autoScore,autoMax});
  }catch(e){await client.query("ROLLBACK").catch(()=>{});res.status(500).json({error:e.message||"Submission failed."})}
  finally{client.release()}
});

app.post("/api/admin/grade/:submissionId",admin,async(req,res)=>{
  try{
    const sr=await pool.query("SELECT * FROM submissions WHERE id=$1",[req.params.submissionId]);
    if(!sr.rows[0]) return res.status(404).json({error:"Submission not found."});
    const s=sr.rows[0], tr=await pool.query("SELECT * FROM tests WHERE id=$1",[s.test_id]), t=tr.rows[0];
    let subjectiveMax=0,subjectiveScore=0,feedback=s.feedback||{};
    for(const q of t.questions){
      if(q.type!=="subjective") continue;
      subjectiveMax+=q.marks;
      const g=req.body.grades?.[q.id];
      if(g){const m=Math.max(0,Math.min(q.marks,Number(g.marks)||0));subjectiveScore+=m;feedback[q.id]={marks:m,feedback:String(g.feedback||"")};}
    }
    const total=s.auto_score+subjectiveScore;
    await pool.query(`UPDATE submissions SET subjective_score=$1,subjective_max=$2,total_score=$3,feedback=$4 WHERE id=$5`,
      [subjectiveScore,subjectiveMax,total,JSON.stringify(feedback),s.id]);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message||"Grade save failed."})}
});

app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("/test/:id",(req,res)=>res.sendFile(path.join(__dirname,"public","test.html")));
app.get("/result/:id",(req,res)=>res.sendFile(path.join(__dirname,"public","result.html")));

initDb().then(()=>app.listen(PORT,()=>console.log(`Test portal running on ${PORT}`)))
.catch(e=>{console.error(e);process.exit(1)});
